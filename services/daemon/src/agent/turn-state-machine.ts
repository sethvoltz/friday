/**
 * Turn-state machine (FRI-145 M3) — CONTEXT.md → "Agent turn lifecycle".
 *
 * The single source of truth for what happens at a turn boundary. The
 * near-duplicate `error` and `turn-complete` tails of the old `handleEvent`
 * switch (wedge detector, per-turn resets, the idle write, the queue drain,
 * the mail-back backstop) are folded into ONE pure function: `apply`.
 *
 * `apply(w, transition, deps)` returns an `ApplyResult`:
 *   - `state`       — the authoritative Turn state after the Transition
 *                     (`idle | working | aborting | force-killed`). Distinct
 *                     from the agents.status Status projection.
 *   - `projection`  — the Status projection (`idle | working | stalled |
 *                     archived`) the agents row should hold, or `null` when
 *                     this Transition writes no projection.
 *   - `mutations`   — in-memory LiveWorker field writes the caller applies
 *                     before executing intents. These are NOT side effects on
 *                     the outside world; they are the machine's own bookkeeping
 *                     (turnStart cleared, streak bumped, activePrompt dropped).
 *   - `intents`     — an ordered list of side-effect descriptions. The machine
 *                     itself performs NO I/O; the caller interprets intents
 *                     against the ports bag. This is what makes the core unit-
 *                     testable with fakes — assert the intents, not a mock.
 *
 * Inviolate (FRI-145): the machine is the only place a turn-boundary Status
 * projection is decided. `registry.setStatus` (the ports `setStatus`) is the
 * only DB door and is reached only by executing a `set-status` intent. The
 * caller never decides a projection on its own.
 *
 * Generation no-op (FRI-145 M2) stays the CALLER's responsibility: the caller
 * gates `apply` behind `isCurrentGeneration(w)` for the IPC-driven Transitions
 * exactly as the old switch did, so a superseded worker's late event never
 * reaches the machine. The machine assumes it only ever runs for the live
 * Generation.
 */

import type { AgentType } from "@friday/shared";
import type { ErrorBlockPayload } from "./block-stream.js";
import type { WorkerPromptCommand } from "./worker-protocol.js";

/**
 * Authoritative Turn state (CONTEXT.md). `force-killed` is a transient state
 * with NO resting agents.status value — it projects/heals to `idle`. `aborting`
 * is the in-flight-kill window. `idle`/`working` are the resting states.
 */
export type TurnState = "idle" | "working" | "aborting" | "force-killed";

/**
 * Status projection (CONTEXT.md → agents.status). The resting set the DB CHECK
 * carries minus the `archive_requested` transient. `stalled` is produced by the
 * watchdog `stall` Transition (M5); `archived` by the `archive` Transition (M4).
 */
export type StatusProjection = "idle" | "working" | "stalled" | "archived";

/**
 * The read surface the machine needs off a LiveWorker. Kept structural (not
 * the full 28-field bag) so the unit tests can pass a minimal double and so the
 * machine can't reach for fields it has no business reading.
 */
export interface TurnContext {
  agentName: string;
  agentType: AgentType;
  model: string;
  parentName?: string;
  turnId: string;
  sessionId?: string;
  workingDirectory: string;
  /** Whether the user requested an abort for the in-flight turn. */
  abortRequested: boolean;
  /** Wall-clock turn start; undefined between turns. */
  turnStart: number | undefined;
  /** Count of block-starts observed this turn. */
  blocksThisTurn: number;
  /** Consecutive zero-block turn-complete/error streak (wedge detector). */
  zeroBlockTurnStreak: number;
  /** Count of mail_send-to-parent tool_use blocks observed this turn. */
  mailSendToParentThisTurn: number;
  /** Single-fire guard: this miss already triggered an Option-B re-dispatch. */
  noMailBackNudgedThisTurn: boolean;
  /** Consecutive no-mail-back turn-complete streak. */
  noMailBackStreak: number;
  /** FIFO of prompts queued while a turn was in flight. */
  nextPrompts: WorkerPromptCommand[];
}

/** Inputs the worker reports at turn-complete. */
export interface CompletePayload {
  sessionId?: string;
  compactionThisTurn?: boolean;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    cost_usd: number;
  };
}

/** Inputs the worker reports at error. */
export interface FailPayload {
  message: string;
  recoverable: boolean;
  code?: string;
  headline?: string;
  httpStatus?: number;
  retryAfterSeconds?: number;
  requestId?: string;
  rawMessage?: string;
}

/**
 * The Transitions the machine accepts. M3 implements the turn-boundary set
 * (`complete`, `fail`) plus `abort`; later milestones add `stall`, `archive`,
 * `heal`, `exit`, etc. against the same pure-apply contract.
 */
export type Transition =
  | { kind: "complete"; payload: CompletePayload }
  | { kind: "fail"; payload: FailPayload }
  | { kind: "abort" };

/**
 * Side-effect descriptions. The machine returns these; the caller executes
 * them against the ports bag in order. Each is a plain serializable object so
 * tests can `toEqual` them.
 */
export type Intent =
  /** Write the agents.status projection through registry.setStatus (the DB door). */
  | { kind: "set-status"; name: string; status: StatusProjection }
  /** Record a synthetic error block (bsRecordError). */
  | { kind: "record-error-block"; payload: ErrorBlockPayload }
  /** Finalize any streaming blocks for this turn (bsFinalize). */
  | { kind: "finalize-blocks"; status: "aborted" | "error" }
  /** Drop the in-flight per-turn block accumulators (bsEndTurn). */
  | { kind: "end-turn"; turnId: string }
  /** Publish the canonical in-band TurnErrorEvent. */
  | {
      kind: "publish-error";
      turnId: string;
      agent: string;
      code: string;
      message: string;
      recoverable: boolean;
    }
  /** Publish the terminal turn_done wire event. */
  | {
      kind: "publish-turn-done";
      turnId: string;
      agent: string;
      status: "complete" | "aborted" | "error";
      abortReason?: "cooperative" | "forced";
      zeroBlockReason?: "abort" | "compaction" | "sdk-resume-failure";
      usage?: CompletePayload["usage"];
    }
  /** Insert a usage row for the completed turn (insertUsage). */
  | {
      kind: "insert-usage";
      sessionId: string;
      agentName: string;
      agentType: AgentType;
      model: string;
      usage: NonNullable<CompletePayload["usage"]>;
      durationMs: number;
    }
  /** Capture a PostHog analytics event. */
  | { kind: "posthog"; event: string; properties: Record<string, unknown> }
  /** Run the post-turn JSONL recovery sweep (recoverFromJsonl). */
  | {
      kind: "recover-jsonl";
      agentName: string;
      sessionId: string;
      workingDirectory: string;
    }
  /** Dispatch the next queued prompt (sendPrompt drain). */
  | { kind: "send-next"; prompt: WorkerPromptCommand }
  /**
   * Re-dispatch the mail-back nudge turn (Option B). When present, the caller
   * MUST skip the normal queue-drain — the nudge owns the worker's next turn.
   */
  | {
      kind: "mailback-nudge";
      prompt: WorkerPromptCommand;
      agent: string;
      parent: string;
      streak: number;
    }
  /** Emit the Option-C no-mail-back streak SSE/log warning (no re-dispatch). */
  | { kind: "mailback-warn"; agent: string; parent: string; turnId: string; streak: number }
  /**
   * Escalate to force-kill (wedge). The caller invokes forceKillStuckWorker;
   * the machine does NOT itself tear down, it only signals the escalation so
   * the streak/threshold decision lives in one place.
   */
  | { kind: "force-kill"; reason: "wedge"; zeroBlockTurnStreak: number }
  /** Structured diagnostic log (e.g. the zero-block-turn streak warning). */
  | { kind: "log"; level: "info" | "warn"; event: string; payload: Record<string, unknown> };

/** In-memory LiveWorker field writes the caller applies post-apply. */
export interface Mutations {
  turnStart?: undefined;
  activePrompt?: undefined;
  blocksThisTurn?: number;
  zeroBlockTurnStreak?: number;
  mailSendToParentThisTurn?: number;
  noMailBackNudgedThisTurn?: boolean;
  noMailBackStreak?: number;
  lastExitStatus?: "complete" | "aborted" | "error";
  completedAtLeastOnce?: boolean;
}

export interface ApplyResult {
  state: TurnState;
  /** The Status projection to write, or null when this Transition writes none. */
  projection: StatusProjection | null;
  mutations: Mutations;
  intents: Intent[];
}

export interface ApplyDeps {
  /** Wedge threshold (zeroBlockTurnStreak that trips force-kill). */
  wedgeThreshold: number;
  /** Current wall-clock (injected so tests pin durations). */
  now: number;
  /** UUID factory for the mail-back nudge turn id. */
  uuid: () => string;
}

/**
 * Project the resting Status projection from a Turn state. `force-killed` and
 * `aborting` are transient Turn states that heal to `idle`. This is the
 * one-way map Turn-state → agents.status; `stalled` and `archived` are not
 * resting Turn states and are produced by their own Transitions.
 */
export function projectStatus(state: TurnState): "idle" | "working" {
  switch (state) {
    case "working":
      return "working";
    case "idle":
    case "aborting":
    case "force-killed":
      return "idle";
  }
}

/**
 * Wedge-detector core, shared by `complete` and `fail`. Returns the streak
 * bookkeeping + whether the threshold tripped. Pure.
 */
function evaluateWedge(w: TurnContext, deps: ApplyDeps): { streak: number; tripped: boolean } {
  if (w.blocksThisTurn === 0) {
    const streak = w.zeroBlockTurnStreak + 1;
    return { streak, tripped: streak >= deps.wedgeThreshold };
  }
  return { streak: 0, tripped: false };
}

/**
 * The mail-back backstop, folded into the machine as intents (FRI-127 §5).
 * Returns the intents + the streak/guard mutations. `nudged` signals the
 * caller to skip the queue-drain (the nudge owns the next turn).
 */
function evaluateMailBack(
  w: TurnContext,
  completedBlocks: number,
  completedMailBacks: number,
  deps: ApplyDeps,
): { intents: Intent[]; mutations: Mutations; nudged: boolean } {
  const isChild = w.agentType === "helper" || w.agentType === "builder";
  if (!isChild || !w.parentName) {
    return { intents: [], mutations: {}, nudged: false };
  }

  if (completedMailBacks > 0) {
    // Reported home — clear the backstop state.
    return {
      intents: [],
      mutations: { noMailBackNudgedThisTurn: false, noMailBackStreak: 0 },
      nudged: false,
    };
  }

  // Zero-block turns are the wedge detector's job, not the mail-back's.
  if (completedBlocks === 0) {
    return { intents: [], mutations: {}, nudged: false };
  }

  const streak = w.noMailBackStreak + 1;

  if (!w.noMailBackNudgedThisTurn) {
    // Option B: single-fire re-dispatch.
    const nudge: WorkerPromptCommand = {
      prompt:
        `You finished your turn without reporting back. Mail your parent ` +
        `\`${w.parentName}\` with your result now via ` +
        `\`mail_send({to: "${w.parentName}", body: …})\` so your parent learns you're done.`,
      turnId: `t_${deps.uuid()}`,
    };
    return {
      intents: [
        {
          kind: "mailback-nudge",
          prompt: nudge,
          agent: w.agentName,
          parent: w.parentName,
          streak,
        },
      ],
      mutations: { noMailBackNudgedThisTurn: true, noMailBackStreak: streak },
      nudged: true,
    };
  }

  // Option C: second consecutive miss — warn + SSE, no re-dispatch.
  return {
    intents: [
      { kind: "mailback-warn", agent: w.agentName, parent: w.parentName, turnId: w.turnId, streak },
    ],
    mutations: { noMailBackStreak: streak },
    nudged: false,
  };
}

/**
 * Build the `error`-block payload for a force-kill `wedge`. Mirrors the
 * forceKillStuckWorker copy so the wedge escalation surfaces identical text
 * whether the machine signals it via the `complete`/`fail` path or the
 * abort-deadline path drives it directly.
 */
export const WEDGE_ERROR_PAYLOAD: ErrorBlockPayload = {
  code: "worker_wedged",
  headline: "Agent looped without producing output — restarted",
  rawMessage:
    "Wedge detected: the worker produced N consecutive turns with " +
    "zero content blocks. Likely cause: SDK could not resume the " +
    "prior session (transcript missing from the encoded-cwd " +
    "project dir), or the model emitted nothing for N turns in a " +
    "row. The agent has been killed; the next message will spawn " +
    "a fresh worker.",
};

/**
 * The pure Transition function. No side effects: it reads `w` (TurnContext),
 * the `transition`, and `deps`, and returns the next state + projection +
 * in-memory mutations + ordered intents. The caller applies the mutations and
 * executes the intents against the ports bag.
 */
export function apply(w: TurnContext, transition: Transition, deps: ApplyDeps): ApplyResult {
  switch (transition.kind) {
    case "complete":
      return applyComplete(w, transition.payload, deps);
    case "fail":
      return applyFail(w, transition.payload, deps);
    case "abort":
      return applyAbort(w);
  }
}

function applyComplete(w: TurnContext, e: CompletePayload, deps: ApplyDeps): ApplyResult {
  const intents: Intent[] = [];
  const durationMs = w.turnStart ? deps.now - w.turnStart : 0;

  // FRI-60: zero-block reason for the dashboard's "didn't respond" copy.
  const zeroBlockReason: "abort" | "compaction" | "sdk-resume-failure" | undefined =
    w.blocksThisTurn === 0
      ? w.abortRequested
        ? "abort"
        : e.compactionThisTurn
          ? "compaction"
          : "sdk-resume-failure"
      : undefined;

  // turn_done FIRST — the dashboard pins/unpins the inflight turn on this.
  intents.push({
    kind: "publish-turn-done",
    turnId: w.turnId,
    agent: w.agentName,
    status: w.abortRequested ? "aborted" : "complete",
    ...(w.abortRequested ? { abortReason: "cooperative" as const } : {}),
    ...(zeroBlockReason !== undefined ? { zeroBlockReason } : {}),
    usage: e.usage,
  });

  if (e.usage && (w.sessionId || e.sessionId)) {
    intents.push({
      kind: "insert-usage",
      sessionId: (w.sessionId ?? e.sessionId)!,
      agentName: w.agentName,
      agentType: w.agentType,
      model: w.model,
      usage: e.usage,
      durationMs,
    });
  }

  intents.push({
    kind: "posthog",
    event: "turn_completed",
    properties: {
      agent_name: w.agentName,
      agent_type: w.agentType,
      model: w.model,
      turn_id: w.turnId,
      aborted: w.abortRequested,
      duration_ms: durationMs,
      input_tokens: e.usage?.input_tokens ?? null,
      output_tokens: e.usage?.output_tokens ?? null,
      cache_creation_tokens: e.usage?.cache_creation_tokens ?? null,
      cache_read_tokens: e.usage?.cache_read_tokens ?? null,
      cost_usd: e.usage?.cost_usd ?? null,
      zero_block_reason: zeroBlockReason ?? null,
    },
  });

  // FRI-4 #2: finalize a mid-stream-abandoned block as aborted so it leaves
  // `streaming`.
  intents.push({ kind: "finalize-blocks", status: "aborted" });

  // FRI-61 wedge detector. Skip when the user requested the abort.
  if (!w.abortRequested) {
    const wedge = evaluateWedge(w, deps);
    if (w.blocksThisTurn === 0) {
      intents.push({
        kind: "log",
        level: "warn",
        event: "worker.zero-block-turn",
        payload: {
          agent: w.agentName,
          turnId: w.turnId,
          sessionId: e.sessionId,
          streak: wedge.streak,
          source: "turn-complete",
        },
      });
    }
    if (wedge.tripped) {
      // Escalate to force-kill — no idle projection, the caller tears down.
      intents.push({
        kind: "force-kill",
        reason: "wedge",
        zeroBlockTurnStreak: wedge.streak,
      });
      return {
        state: "force-killed",
        projection: null,
        mutations: {
          turnStart: undefined,
          activePrompt: undefined,
          zeroBlockTurnStreak: wedge.streak,
        },
        intents,
      };
    }
  }

  // Capture counts BEFORE the per-turn resets for the mail-back backstop.
  const completedBlocks = w.blocksThisTurn;
  const completedMailBacks = w.mailSendToParentThisTurn;
  const wedgeStreak = w.abortRequested ? w.zeroBlockTurnStreak : evaluateWedge(w, deps).streak;

  // Per-turn end teardown intent.
  intents.push({ kind: "end-turn", turnId: w.turnId });

  // Heal to idle.
  intents.push({ kind: "set-status", name: w.agentName, status: "idle" });

  // Per-turn recovery sweep.
  const sessionForRecovery = w.sessionId ?? e.sessionId;
  if (sessionForRecovery) {
    intents.push({
      kind: "recover-jsonl",
      agentName: w.agentName,
      sessionId: sessionForRecovery,
      workingDirectory: w.workingDirectory,
    });
  }

  // Mail-back backstop (FRI-127 §5).
  const mailBack = evaluateMailBack(w, completedBlocks, completedMailBacks, deps);
  intents.push(...mailBack.intents);

  // Queue-drain — UNLESS the mail-back nudge owns the next turn.
  if (!mailBack.nudged) {
    const next = w.nextPrompts[0];
    if (next) intents.push({ kind: "send-next", prompt: next });
  }

  return {
    state: "idle",
    projection: "idle",
    mutations: {
      turnStart: undefined,
      activePrompt: undefined,
      blocksThisTurn: 0,
      zeroBlockTurnStreak: wedgeStreak,
      completedAtLeastOnce: true,
      lastExitStatus: w.abortRequested ? "aborted" : "complete",
      ...mailBack.mutations,
    },
    intents,
  };
}

function applyFail(w: TurnContext, e: FailPayload, deps: ApplyDeps): ApplyResult {
  const intents: Intent[] = [];
  const wasAbort = w.abortRequested;

  // Materialize a chat-visible error block (skip plain aborts).
  if (!wasAbort) {
    intents.push({
      kind: "record-error-block",
      payload: {
        code: e.code ?? "worker_error",
        headline: e.headline ?? e.message,
        httpStatus: e.httpStatus,
        retryAfterSeconds: e.retryAfterSeconds,
        requestId: e.requestId,
        rawMessage: e.rawMessage ?? e.message,
      },
    });
  }

  // Close any streaming blocks.
  intents.push({ kind: "finalize-blocks", status: wasAbort ? "aborted" : "error" });

  // Canonical TurnErrorEvent BEFORE turn_done.
  intents.push({
    kind: "publish-error",
    turnId: w.turnId,
    agent: w.agentName,
    code: wasAbort ? "aborted" : (e.code ?? "worker_error"),
    message: e.message,
    recoverable: e.recoverable,
  });

  intents.push({
    kind: "publish-turn-done",
    turnId: w.turnId,
    agent: w.agentName,
    status: wasAbort ? "aborted" : "error",
    ...(wasAbort ? { abortReason: "cooperative" as const } : {}),
  });

  if (!wasAbort) {
    intents.push({
      kind: "posthog",
      event: "turn_errored",
      properties: {
        agent_name: w.agentName,
        agent_type: w.agentType,
        model: w.model,
        turn_id: w.turnId,
        error_code: e.code ?? null,
        error_message: e.message,
        recoverable: e.recoverable,
      },
    });
  }

  // FRI-61 wedge detector — skip aborts.
  if (!wasAbort) {
    const wedge = evaluateWedge(w, deps);
    if (w.blocksThisTurn === 0) {
      intents.push({
        kind: "log",
        level: "warn",
        event: "worker.zero-block-turn",
        payload: {
          agent: w.agentName,
          turnId: w.turnId,
          streak: wedge.streak,
          source: "error",
          errorCode: e.code,
        },
      });
    }
    if (wedge.tripped) {
      intents.push({
        kind: "force-kill",
        reason: "wedge",
        zeroBlockTurnStreak: wedge.streak,
      });
      return {
        state: "force-killed",
        projection: null,
        mutations: {
          turnStart: undefined,
          activePrompt: undefined,
          zeroBlockTurnStreak: wedge.streak,
        },
        intents,
      };
    }
  }

  const wedgeStreak = wasAbort ? w.zeroBlockTurnStreak : evaluateWedge(w, deps).streak;

  intents.push({ kind: "end-turn", turnId: w.turnId });
  intents.push({ kind: "set-status", name: w.agentName, status: "idle" });

  // Queue-drain.
  const next = w.nextPrompts[0];
  if (next) intents.push({ kind: "send-next", prompt: next });

  return {
    state: "idle",
    projection: "idle",
    mutations: {
      turnStart: undefined,
      activePrompt: undefined,
      blocksThisTurn: 0,
      zeroBlockTurnStreak: wedgeStreak,
      completedAtLeastOnce: true,
      lastExitStatus: wasAbort ? "aborted" : "error",
    },
    intents,
  };
}

/**
 * The `abort` Transition projects `aborting`. The CALLER owns sending the
 * abort IPC, killing pgrp descendants, and arming the 500ms force-kill
 * deadline (those are not turn-boundary state decisions). The machine's job
 * is to pin the Turn state so any concurrent projection read sees `aborting`,
 * not `working`. No projection write — `aborting` heals to `idle` and the DB
 * row stays `working` until the cooperative turn-complete/error lands.
 */
function applyAbort(_w: TurnContext): ApplyResult {
  return {
    state: "aborting",
    projection: null,
    mutations: {},
    intents: [],
  };
}
