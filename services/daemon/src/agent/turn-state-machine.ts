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

import type { AgentType, ArchiveReason } from "@friday/shared";
import type { ErrorBlockPayload } from "./block-injectors.js";
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
  /**
   * FRI-156 follow-up: the DB `blocks.source` of the block that originated this
   * turn (`"user_chat"`, `"mail"`, `"schedule"`, …). Drives the zero-block
   * carve-out — a `user_chat`-origin turn that produced zero content blocks
   * MUST emit a visible notice block (the user is waiting on a reply and has no
   * other surface) rather than vanish silently. Undefined for autonomous /
   * system-origin turns, which keep the existing silent zero-block behavior.
   */
  turnSource?: string;
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

/** Per-API-request usage row (no cost; one per SDK `assistant` message). */
export interface RequestUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
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
  /** Per-request usage for the turn (one per `assistant` message), persisted to
   *  `usage_request` for live-context back-compute. Omitted when none. */
  requestUsages?: RequestUsage[];
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
  | { kind: "abort" }
  | { kind: "stall" }
  | { kind: "hard-exit" };

/**
 * Administrative Transitions (FRI-145 M4). These route the three non-turn-
 * boundary channels — archive, boot-recovery, auditor — through the same
 * single-writer machine. They operate on an agent NAME, not a live worker
 * (the agent may have no live worker at all: a boot-recovery reset, an orphan
 * archive, an auditor heal). They carry no turn-boundary bookkeeping; their
 * whole job is to decide ONE Status projection and emit the ordered intents
 * that write it. The pure {@link applyAdmin} is their `apply`.
 *
 *   - `archive`  — terminal `archived` projection. Emits `close-ticket` BEFORE
 *                  the `archive` intent so the linked Friday/Linear ticket is
 *                  closed strictly before the row goes terminal (AC #6). The
 *                  `archive` intent reaches `registry.archiveAgent` (the DB
 *                  door), which runs the FSM gate — an orchestrator-archive or
 *                  any illegal edge throws `IllegalTransitionError`, surfaced
 *                  to the awaiting caller via the result-bearing enqueue.
 *   - `heal`     — the auditor's force-set. Bypasses the FSM gate via the
 *                  privileged `_auditorHealStatusUnchecked` (the machine's
 *                  internal force-set; ADR-031). Used only for illegal RESTING
 *                  states the gate cannot reach (e.g. orchestrator stuck at
 *                  `archived`).
 *   - `set-projection` — a gated `registry.setStatus` write for the channels
 *                  that legitimately move an agent to a resting projection
 *                  (boot `working→idle`, auditor zombie-demote `→idle`).
 */
export type AdminTransition =
  | { kind: "archive"; reason: ArchiveReason; ticketId: string | null }
  | { kind: "heal"; target: StatusProjection; clearArchiveReason: boolean }
  | { kind: "set-projection"; status: StatusProjection };

/** The Status projection an {@link AdminTransition} writes. */
export interface AdminResult {
  projection: StatusProjection;
  intents: Intent[];
}

/**
 * Side-effect descriptions. The machine returns these; the caller executes
 * them against the ports bag in order. Each is a plain serializable object so
 * tests can `toEqual` them.
 */
export type Intent =
  /** Write the agents.status projection through registry.setStatus (the DB door). */
  | { kind: "set-status"; name: string; status: StatusProjection }
  /**
   * Close the agent's linked Friday/Linear ticket (closeTicketForArchive). The
   * archive Transition emits this BEFORE its `archive` intent so the ticket is
   * closed strictly before the agents row goes terminal (FRI-145 AC #6). A
   * `null` ticketId is a no-op in the executor.
   */
  | { kind: "close-ticket"; name: string; ticketId: string | null; reason: ArchiveReason }
  /**
   * Archive the agent via registry.archiveAgent (the DB door). Runs the FSM
   * gate; an illegal edge (orchestrator-archive) throws and the executor
   * propagates it to the awaiting caller.
   */
  | { kind: "archive"; name: string; reason: ArchiveReason }
  /**
   * Auditor force-set (registry._auditorHealStatusUnchecked). Bypasses the FSM
   * gate — the machine's internal heal path for illegal resting states (ADR-031).
   */
  | { kind: "heal"; name: string; status: StatusProjection; clearArchiveReason: boolean }
  /** Record a synthetic error block (bsRecordError). */
  | { kind: "record-error-block"; payload: ErrorBlockPayload }
  /**
   * Tear down the turn (FRI-148 A): finalize any streaming blocks at the given
   * terminal status AND drop the per-turn block accumulator. Fuses the old
   * `finalize-blocks` + `end-turn` pair, which were always emitted adjacently
   * and always called the block-stream module's finalize + endTurn in sequence.
   * Carries the turnId so the executor can drop the accumulator without
   * threading the worker's mutable `turnId` (a `send-next` earlier in the
   * intent list may have re-stamped it).
   */
  | { kind: "tear-down-turn"; turnId: string; status: "aborted" | "error" }
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
  /** Insert the per-API-request usage rows for the turn (insertUsageRequests).
   *  Back-computes live context for the nightly compaction sweep. */
  | {
      kind: "insert-usage-requests";
      sessionId: string;
      agentName: string;
      turnId: string;
      requestUsages: RequestUsage[];
    }
  /** Capture a PostHog analytics event, attributed to the turn's author
   *  (PR #145). The author-resolve is async I/O, so the port — not this pure
   *  machine — turns `turnId` into the originating user. */
  | { kind: "posthog"; turnId: string; event: string; properties: Record<string, unknown> }
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
 * FRI-156 follow-up (SEV-0 safety net): the visible notice block emitted when
 * an INTERACTIVE (`user_chat`-origin) turn completes with zero content blocks.
 * Without this, such a turn is zero-blocked silently (FRI-156 suppresses the
 * synthesized "no response" bubble) and the user's message vanishes with no
 * reply surface. Kept as an `ErrorBlockPayload` (kind=`error`) so it renders
 * through the dashboard's existing error-bubble path — no new block kind. This
 * is a last-resort backstop; the primary fix (dispatch routing) means a healthy
 * user_chat turn produces real content blocks and never reaches here.
 */
export const ZERO_BLOCK_USER_CHAT_PAYLOAD: ErrorBlockPayload = {
  code: "no_response_generated",
  headline: "No response was generated for this turn.",
  rawMessage:
    "The agent finished this turn without producing any content. Your message " +
    "was received and saved, but the agent returned nothing to show. Try " +
    "sending it again, or rephrasing.",
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
    case "stall":
      return applyStall(w);
    case "hard-exit":
      return applyHardExit(w);
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

  const sessionForUsage = w.sessionId ?? e.sessionId;
  if (e.usage && sessionForUsage) {
    intents.push({
      kind: "insert-usage",
      sessionId: sessionForUsage,
      agentName: w.agentName,
      agentType: w.agentType,
      model: w.model,
      usage: e.usage,
      durationMs,
    });
  }

  // Per-request usage rows for live-context back-compute (nightly sweep).
  // Independent of the cumulative `usage` gate above: a turn can stream
  // per-request usage even on a path that doesn't produce a final result row.
  if (e.requestUsages && e.requestUsages.length > 0 && sessionForUsage) {
    intents.push({
      kind: "insert-usage-requests",
      sessionId: sessionForUsage,
      agentName: w.agentName,
      turnId: w.turnId,
      requestUsages: e.requestUsages,
    });
  }

  intents.push({
    kind: "posthog",
    turnId: w.turnId,
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

  // FRI-61 wedge detector. Skip when the user requested the abort. FRI-148 A:
  // the zero-block log moves BEFORE the tear-down-turn so the fused intent
  // remains the contiguous "finalize + drop" boundary — log/diagnostic intents
  // never split the pair.
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
      // Still tear down this turn first (FRI-4 #2): a mid-stream-abandoned
      // block must leave `streaming` before forceKillStuckWorker's own
      // bsTearDownTurn fires (it's a no-op the second time around — the
      // accumulator is already gone — which is exactly the idempotent
      // behavior we want from the fused op).
      intents.push({ kind: "tear-down-turn", turnId: w.turnId, status: "aborted" });
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

  // FRI-156 follow-up (SEV-0 safety net): a user message can NEVER vanish
  // silently. An INTERACTIVE (`user_chat`-origin) turn that produced zero
  // content blocks AND was not a user-requested abort gets a VISIBLE notice
  // block instead of being zero-blocked into nothing. Emitted BEFORE
  // tear-down-turn so it lands in the still-live turn's accumulator with a
  // real block_index. Autonomous / system-origin turns (mail, schedule, …)
  // keep the existing silent zero-block behavior — they have other reply
  // surfaces (mail) and a turnless autonomous fire legitimately emits nothing.
  // Aborts are excluded: the user explicitly stopped the turn and the dashboard
  // already renders the abort state. The wedge-tripped path returned above and
  // records its own WEDGE_ERROR_PAYLOAD, so this never double-fires.
  if (w.blocksThisTurn === 0 && !w.abortRequested && w.turnSource === "user_chat") {
    intents.push({ kind: "record-error-block", payload: ZERO_BLOCK_USER_CHAT_PAYLOAD });
  }

  // FRI-4 #2 + FRI-148 A: finalize a mid-stream-abandoned block as aborted so
  // it leaves `streaming`, AND drop the per-turn accumulator. The two used to
  // be separate adjacent intents; tear-down-turn fuses them so callers can't
  // forget the second half.
  intents.push({ kind: "tear-down-turn", turnId: w.turnId, status: "aborted" });

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

  // FRI-148 A (A1-default reorder): the old order emitted finalize-blocks here,
  // then publish-error/publish-turn-done/posthog/log, then end-turn at the tail.
  // The pair is now fused into one tear-down-turn intent and MOVED to
  // immediately follow record-error-block, so the boundary "finalize the
  // streaming rows AND drop the turn accumulator" runs as one contiguous
  // operation. The user-visible SSE order (error → turn_done) is preserved —
  // tear-down-turn emits per-block `block_complete` SSEs (same as the old
  // finalize) but does NOT emit the turn-level error/turn_done events.
  intents.push({
    kind: "tear-down-turn",
    turnId: w.turnId,
    status: wasAbort ? "aborted" : "error",
  });

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
      turnId: w.turnId,
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

/**
 * The `stall` Transition (FRI-145 M5) projects `agents.status="stalled"` — the
 * dashboard's warn-colored dot. The watchdog enqueues it fire-and-forget when a
 * working worker blows past its heartbeat budget (V3: never awaited inside the
 * watchdog tick, so one stalled agent can't head-of-line-block the others).
 *
 * `stalled` is a Status PROJECTION with no resting Turn state (V1): the worker
 * is still `working` from the machine's point of view — it just hasn't made
 * progress — so the Turn state stays `working` and only the durable projection
 * moves to `stalled`. The in-memory `w.status` therefore stays `working` (the
 * watchdog keeps counting against it; a refork or a recovered heartbeat is what
 * clears the flag), while the DB row reflects `stalled` for the dashboard.
 *
 * Single intent, no mutations: the `set-status` write through the ports
 * `setStatus` keeps the Turn-state machine the sole `agents.status` writer.
 */
function applyStall(w: TurnContext): ApplyResult {
  return {
    state: "working",
    projection: "stalled",
    mutations: {},
    intents: [{ kind: "set-status", name: w.agentName, status: "stalled" }],
  };
}

/**
 * The `hard-exit` Transition (FRI-145 M5) is the self-heal for a worker process
 * that died mid-turn with NO terminal turn-complete/error ever processed
 * (SIGTERM from the stall watchdog, SIGKILL, OOM, crash). Bug #2 was that the
 * old exit handler finalized streaming blocks and reset the row to `idle` but
 * never published `turn_done` — so the dashboard's inflight turn pin stayed up
 * forever and the agent looked stuck despite being dispatchable.
 *
 * "No terminal turn" is exactly `w.turnStart !== undefined`: every cooperative
 * turn-end (`complete`/`fail`/force-kill) clears `turnStart` as part of its
 * mutations, so a still-set `turnStart` at exit means the turn never reached a
 * terminal event. When a turn WAS in flight we:
 *   - finalize any streaming blocks as `error` (they never got a block-stop),
 *   - publish the canonical in-band `error` event, then
 *   - publish the missing `turn_done{status:"error"}` so the dashboard unpins.
 *
 * Either way we project `idle` (dispatchable — no sticky dead state; no daemon
 * restart needed) and clear the per-turn bookkeeping. There is no queue-drain:
 * the worker process is gone, so the next dispatch forks a fresh worker.
 */
function applyHardExit(w: TurnContext): ApplyResult {
  const intents: Intent[] = [];
  const turnWasLive = w.turnStart !== undefined;

  if (turnWasLive) {
    // Streaming blocks for the dead turn never got their own block-stop —
    // flip them off `streaming` so the dashboard's tool/thinking bubbles
    // don't render `running` forever. FRI-148 A: finalize + drop fused into
    // one intent (the pair was already adjacent here — straight collapse).
    intents.push({ kind: "tear-down-turn", turnId: w.turnId, status: "error" });
    // Canonical in-band error so any consumer still listening knows the turn
    // died (vs. a clean exit between turns).
    intents.push({
      kind: "publish-error",
      turnId: w.turnId,
      agent: w.agentName,
      code: "worker_exited",
      message: "Worker process exited mid-turn before reporting completion",
      recoverable: true,
    });
    // Bug #2 fix: the missing terminal event. The dashboard pins/unpins the
    // inflight turn on this; without it the turn stayed pinned forever.
    intents.push({
      kind: "publish-turn-done",
      turnId: w.turnId,
      agent: w.agentName,
      status: "error",
    });
  }

  // Heal to idle so the agent is dispatchable. The caller is responsible for
  // the archived-terminal guard (a worker that exited because archiveAgent
  // asked it to stop is a superseded Generation and never reaches this
  // Transition) — the machine always heals a live-Generation hard exit.
  intents.push({ kind: "set-status", name: w.agentName, status: "idle" });

  return {
    state: "idle",
    projection: "idle",
    mutations: {
      turnStart: undefined,
      activePrompt: undefined,
      blocksThisTurn: 0,
      lastExitStatus: "error",
    },
    intents,
  };
}

/**
 * The pure Transition function for the administrative channels (FRI-145 M4):
 * archive, boot-recovery, auditor. Like {@link apply}, it performs NO I/O — it
 * reads the agent NAME + the transition params and returns the Status
 * projection + ordered intents the caller executes against the ports bag. This
 * is what makes the single-writer invariant testable: archive/heal/boot all
 * funnel the SAME machine, so the projection decision lives in exactly one
 * place and the unit tests assert the intents, not a mock.
 *
 * Ordering pin (AC #6): the `archive` transition emits `close-ticket` BEFORE
 * `archive`, so the executor closes the linked ticket strictly before the
 * agents row goes terminal — replacing the old fire-and-forget close that
 * raced the archive write.
 */
export function applyAdmin(name: string, transition: AdminTransition): AdminResult {
  switch (transition.kind) {
    case "archive":
      return {
        projection: "archived",
        intents: [
          {
            kind: "close-ticket",
            name,
            ticketId: transition.ticketId,
            reason: transition.reason,
          },
          { kind: "archive", name, reason: transition.reason },
        ],
      };
    case "heal":
      return {
        projection: transition.target,
        intents: [
          {
            kind: "heal",
            name,
            status: transition.target,
            clearArchiveReason: transition.clearArchiveReason,
          },
        ],
      };
    case "set-projection":
      return {
        projection: transition.status,
        intents: [{ kind: "set-status", name, status: transition.status }],
      };
  }
}
