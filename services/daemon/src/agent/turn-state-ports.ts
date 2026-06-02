/**
 * Turn-state machine ports (FRI-145 M3).
 *
 * The pure machine in {@link ./turn-state-machine.ts} returns intents; this
 * module defines the collaborator interface (the "ports bag") and the executor
 * that interprets intents against it. Production wires the real collaborators
 * (`registry.setStatus`, the `eventBus`, the block-stream module, `insertUsage`,
 * `posthog`, `recoverFromJsonl`); unit tests pass fakes and assert on the
 * recorded calls + the intents the machine emitted.
 *
 * Keeping the executor here (not in the pure core) is the seam that lets the
 * core be tested with zero I/O: `apply` decides WHAT happens, `executeIntents`
 * decides HOW, and the ports bag is the only place real side effects live.
 */

import type { AgentType, ArchiveReason } from "@friday/shared";
import type { WireEvent } from "@friday/shared";
import type { ErrorBlockPayload } from "./block-injectors.js";
import type { WorkerPromptCommand } from "./worker-protocol.js";
import type { Intent, StatusProjection } from "./turn-state-machine.js";

/**
 * Distribute `Omit<…, "seq">` across the WireEvent union so a single variant
 * can be constructed without `seq` (matching `eventBus.publish`'s input). A
 * plain `Omit<WireEvent, "seq">` collapses the union to its common keys and
 * rejects variant-specific fields like `turn_id` / `usage`.
 */
type WireEventInput = WireEvent extends infer U
  ? U extends WireEvent
    ? Omit<U, "seq">
    : never
  : never;

/** A LiveWorker-shaped target the block-stream + sendPrompt ports operate on. */
export interface PortWorker {
  agentName: string;
  turnId: string;
  sessionId?: string;
}

/**
 * The collaborator interface the executor depends on. Each method maps to one
 * intent family. Side-effecting collaborators are injected so tests can swap in
 * fakes; production passes {@link prodPorts}.
 */
export interface TurnStatePorts<W extends PortWorker = PortWorker> {
  /** registry.setStatus — the ONLY DB door for agents.status (ADR-031). */
  setStatus: (name: string, status: StatusProjection) => Promise<void>;
  /**
   * registry.archiveAgent — the gated terminal write (FRI-145 M4 archive
   * channel). Runs the FSM gate; an illegal edge throws and the executor
   * propagates it so an awaiting caller (the REST archive endpoint, the
   * orchestrator-not-archivable test) sees the rejection.
   */
  archive: (name: string, opts: { reason: ArchiveReason }) => Promise<void>;
  /**
   * registry._auditorHealStatusUnchecked — the privileged force-set (FRI-145
   * M4 auditor channel). Bypasses the FSM gate for illegal resting states.
   */
  heal: (
    name: string,
    status: StatusProjection,
    opts: { clearArchiveReason: boolean },
  ) => Promise<void>;
  /**
   * closeTicketForArchive — close the agent's linked Friday/Linear ticket.
   * Awaited so the close happens-before the `archive` intent's terminal write
   * (AC #6). The closer swallows its own errors; a `null` ticketId is a no-op.
   */
  closeTicket: (opts: {
    ticketId: string | null;
    reason: ArchiveReason;
    agentName: string;
  }) => Promise<void>;
  /** eventBus.publish — wire-event fan-out. */
  publish: (event: WireEventInput) => void;
  /** Block-stream FSM pipeline. FRI-148 A fused the previous finalize +
   *  endTurn pair into a single `tearDownTurn` op so the executor can't drive
   *  one without the other. The synthetic recordError writer lives on the
   *  {@link blockInjector} port — split out in FRI-148 B so the FSM core's
   *  port surface matches the FSM module's exports. */
  blockStream: {
    tearDownTurn: (w: W, status: "aborted" | "error") => Promise<void>;
  };
  /** Synthetic block writers that piggyback on the FSM accumulator
   *  ({@link ./block-injectors.ts}). Currently only `recordError`; the
   *  bag is grouped so future injectors (admin-injected notice blocks,
   *  app-installed seed blocks, etc.) extend this port rather than the
   *  FSM port. */
  blockInjector: {
    recordError: (w: W, payload: ErrorBlockPayload) => Promise<unknown>;
  };
  /** Post-turn JSONL recovery sweep. */
  recoverFromJsonl: (
    inputs: { agentName: string; sessionId: string; workingDirectory: string }[],
  ) => Promise<unknown>;
  /** Usage row insert. */
  insertUsage: (row: {
    timestamp: string;
    sessionId: string;
    agentName: string;
    agentType: AgentType;
    model: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    durationMs: number;
  }) => Promise<void>;
  /** Analytics capture, attributed to the turn's author (PR #145). The prod
   *  wiring resolves the originating user from the turn's user block (falling
   *  back to the service actor for autonomous turns) and captures under that
   *  identity. The author-resolve is async I/O, so it lives here in the port,
   *  not in the pure machine. */
  captureTurnEvent: (
    turnId: string,
    event: string,
    properties: Record<string, unknown>,
  ) => void | Promise<void>;
  /** Dispatch the next queued / nudge prompt. */
  sendPrompt: (w: W, p: WorkerPromptCommand) => void;
  /** Escalate to force-kill (wedge). */
  forceKill: (w: W, opts: { reason: "wedge"; zeroBlockTurnStreak: number }) => Promise<void>;
  /** Structured warn-log (set-status error, usage-insert error, mail-back streak). */
  logWarn: (event: string, payload: Record<string, unknown>) => void;
  /** Structured info-log (mail-back nudge dispatch). */
  logInfo: (event: string, payload: Record<string, unknown>) => void;
}

/**
 * Execute the machine's intents against the ports bag. Returns once all the
 * AWAITED side effects (status writes, block finalize/record, force-kill)
 * settle; fire-and-forget intents (usage insert, JSONL recovery) are launched
 * but not awaited, matching the old handler's behavior.
 *
 * `w` is the live worker the block-stream ports operate on (its `turnId` may
 * already have been re-stamped by a `send-next` intent dispatched earlier in
 * the list — so `recordError`/`finalize` MUST run before `send-next`; the
 * machine emits them in that order).
 */
export async function executeIntents<W extends PortWorker>(
  w: W,
  intents: Intent[],
  ports: TurnStatePorts<W>,
): Promise<void> {
  for (const intent of intents) {
    switch (intent.kind) {
      case "set-status":
        await ports.setStatus(intent.name, intent.status).catch((err: unknown) => {
          ports.logWarn("registry.set-status.error", {
            agent: intent.name,
            status: intent.status,
            message: err instanceof Error ? err.message : String(err),
          });
        });
        break;
      case "close-ticket":
        // Close the linked ticket BEFORE the `archive` intent's terminal write
        // (AC #6). Awaited so the happens-before is structural, not a race.
        // The closer swallows its own errors internally; we still guard so a
        // surprise throw can't abort the archive write that must follow.
        await ports
          .closeTicket({
            ticketId: intent.ticketId,
            reason: intent.reason,
            agentName: intent.name,
          })
          .catch((err: unknown) => {
            ports.logWarn("ticket.close.error", {
              agent: intent.name,
              ticketId: intent.ticketId,
              message: err instanceof Error ? err.message : String(err),
            });
          });
        break;
      case "archive":
        // The gated terminal write. NOT wrapped in a catch: an illegal-edge
        // rejection (orchestrator-archive, MISSING_ARCHIVE_REASON) MUST
        // propagate so the awaiting caller (REST endpoint, lifecycle.archiveAgent
        // wrapper) sees the IllegalTransitionError exactly as the pre-M4 direct
        // call did.
        await ports.archive(intent.name, { reason: intent.reason });
        break;
      case "heal":
        await ports
          .heal(intent.name, intent.status, { clearArchiveReason: intent.clearArchiveReason })
          .catch((err: unknown) => {
            ports.logWarn("registry.heal.error", {
              agent: intent.name,
              status: intent.status,
              message: err instanceof Error ? err.message : String(err),
            });
          });
        break;
      case "record-error-block":
        await ports.blockInjector.recordError(w, intent.payload);
        break;
      case "tear-down-turn":
        await ports.blockStream.tearDownTurn(w, intent.status);
        break;
      case "publish-error":
        ports.publish({
          v: 1,
          type: "error",
          turn_id: intent.turnId,
          agent: intent.agent,
          code: intent.code,
          message: intent.message,
          recoverable: intent.recoverable,
        });
        break;
      case "publish-turn-done":
        ports.publish({
          v: 1,
          type: "turn_done",
          turn_id: intent.turnId,
          agent: intent.agent,
          status: intent.status,
          ...(intent.abortReason ? { abort_reason: intent.abortReason } : {}),
          ...(intent.zeroBlockReason ? { zero_block_reason: intent.zeroBlockReason } : {}),
          usage: intent.usage
            ? {
                input_tokens: intent.usage.input_tokens,
                output_tokens: intent.usage.output_tokens,
                cache_creation_tokens: intent.usage.cache_creation_tokens,
                cache_read_tokens: intent.usage.cache_read_tokens,
                cost_usd: intent.usage.cost_usd,
              }
            : undefined,
        });
        break;
      case "insert-usage":
        // Fire-and-forget (ADR-023): the handler stays responsive.
        void ports
          .insertUsage({
            timestamp: new Date().toISOString(),
            sessionId: intent.sessionId,
            agentName: intent.agentName,
            agentType: intent.agentType,
            model: intent.model,
            costUsd: intent.usage.cost_usd,
            inputTokens: intent.usage.input_tokens,
            outputTokens: intent.usage.output_tokens,
            cacheCreationTokens: intent.usage.cache_creation_tokens,
            cacheReadTokens: intent.usage.cache_read_tokens,
            durationMs: intent.durationMs,
          })
          .catch((err: unknown) => {
            ports.logWarn("usage.insert.error", {
              agent: intent.agentName,
              message: err instanceof Error ? err.message : String(err),
            });
          });
        break;
      case "posthog":
        await ports.captureTurnEvent(intent.turnId, intent.event, intent.properties);
        break;
      case "recover-jsonl":
        // Fire-and-forget on the next tick (matches the old setImmediate path).
        {
          const { agentName, sessionId, workingDirectory } = intent;
          setImmediate(() => {
            void ports
              .recoverFromJsonl([{ agentName, sessionId, workingDirectory }])
              .catch((err: unknown) => {
                ports.logWarn("jsonl-recovery.post-turn.error", {
                  agent: agentName,
                  session: sessionId,
                  message: err instanceof Error ? err.message : String(err),
                });
              });
          });
        }
        break;
      case "send-next":
        // The caller pops the queue; sendPrompt re-stamps w.turnId/turnStart.
        ports.sendPrompt(w, intent.prompt);
        break;
      case "mailback-nudge":
        ports.logInfo("worker.no-mail-back-nudge", {
          agent: intent.agent,
          parent: intent.parent,
          turnId: intent.prompt.turnId,
          streak: intent.streak,
        });
        ports.sendPrompt(w, intent.prompt);
        break;
      case "mailback-warn":
        ports.logWarn("worker.no-mail-back-streak", {
          agent: intent.agent,
          parent: intent.parent,
          turnId: intent.turnId,
          streak: intent.streak,
        });
        ports.publish({
          v: 1,
          type: "worker.no-mail-back",
          agent: intent.agent,
          turn_id: intent.turnId,
          streak: intent.streak,
        });
        break;
      case "log":
        if (intent.level === "warn") ports.logWarn(intent.event, intent.payload);
        else ports.logInfo(intent.event, intent.payload);
        break;
      case "force-kill":
        await ports.forceKill(w, {
          reason: intent.reason,
          zeroBlockTurnStreak: intent.zeroBlockTurnStreak,
        });
        break;
    }
  }
}
