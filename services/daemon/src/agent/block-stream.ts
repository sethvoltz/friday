/**
 * block-stream — the per-block FSM core (FRI-125, refactored FRI-148 B).
 *
 * Absorbs the previous {@link ./live-turns.ts} in-memory accumulator, the
 * `writeAndPublish` helper from lifecycle.ts, and the
 * `finalizeStreamingBlocks` path into a single module that owns the
 * ADR-004/024 invariant: in-memory accumulator updated before SSE emit;
 * on `block_complete`, the canonical row INSERTs with `streaming=false`.
 * There is no per-row `last_event_seq` peek dance anymore — the column
 * retires in the same PR and the dashboard's cursor is fed by the SSE
 * event's own `seq` field (which {@link eventBus} stamps at publish time).
 *
 * FRI-148 B split: the two SYNTHETIC writers (`recordError`,
 * `recordUserBlock`) and their `ErrorBlockPayload` / `RecordUserBlockInput`
 * shapes moved to {@link ./block-injectors.ts}. The FSM core here owns the
 * `start → delta* → terminal` lifecycle for the streamed-from-the-worker
 * blocks and the exit-time finalize path. The injectors call back into
 * this module via {@link peekNextBlockIndex} (so recordError can place its
 * synthetic row at `max(in-flight) + 1`) and {@link maybeEmitAgentMessage}
 * (so the user-visible-content fan-out fires on both paths).
 *
 * Public surface:
 *
 *   open / append / close / cancel       — the four block-IPC handlers
 *   tearDownTurn                         — exit-time teardown + accumulator drop (FRI-148 A:
 *                                          fuses the old finalize + endTurn pair)
 *   __endTurnForArchivedHardExit         — narrow archive-only bare end-turn (FRI-148 A)
 *   peekNextBlockIndex                   — read accessor used by recordError
 *   maybeEmitAgentMessage                — user-visible-content fan-out (used by injectors)
 *   hasLiveTurn / peekLiveBlock          — narrow readers (FRI-148 E)
 *   __snapshotForTest                    — full-graph read surface (test-only)
 *   __resetForTest / __seedForTest       — test seam
 *
 * The in-memory `Map<turnId, LiveTurn>` is module-private; callers
 * interact only through the exported functions.
 */

import { randomUUID } from "node:crypto";

import { eventBus } from "../events/bus.js";
import { logger } from "../log.js";
import {
  insertBlock,
  updateBlock,
  getBlockById,
  type BlockKind,
  type BlockSource,
} from "@friday/shared/services";

import type {
  WorkerBlockStart,
  WorkerBlockDelta,
  WorkerBlockStop,
  WorkerBlockCancel,
} from "./worker-protocol.js";
import type { LiveWorker } from "./lifecycle.js";

/* ---------------- Per-block state machine (FRI-145 M6) ----------------
 *
 * Each block runs a tiny lifecycle: `start → delta* → (complete | error |
 * finalize)`. Before M6 the handlers were forgiving — `append`/`close` on an
 * unknown clientBlockId silently no-op'd, and a second `close` after the first
 * either issued a dup-key INSERT (caught + warn-logged) or a zero-row UPDATE.
 * Both swallowed a real protocol violation. M6 enforces the sequence at the
 * interface: an illegal call throws {@link IllegalBlockTransitionError} (caught
 * + logged by `safeHandleEvent`, never crashing the daemon) instead of
 * fabricating a write. The INSERT-vs-UPDATE choice now lives entirely inside
 * this module (see {@link close} / {@link finalize}).
 *
 * State is two-tiered per turn: the in-flight `blocks` map holds OPEN blocks
 * (the watchdog/snapshot read surface), and a `closed` set records every block
 * id that has reached a terminal state (complete / error / canceled /
 * finalized). The pair lets the machine distinguish:
 *   - `append`/`close` before `start`   → BLOCK_NOT_STARTED
 *   - `append`/`close` after terminal   → BLOCK_ALREADY_CLOSED
 *   - second `start` for the same id    → BLOCK_ALREADY_STARTED
 */

export type IllegalBlockTransitionCode =
  | "BLOCK_NOT_STARTED"
  | "BLOCK_ALREADY_STARTED"
  | "BLOCK_ALREADY_CLOSED";

/**
 * Thrown when a block-IPC call violates the `start → delta* → terminal`
 * sequence. Carries the offending op + clientBlockId so the
 * `worker.ipc.error` log line (emitted by `safeHandleEvent`) is diagnosable.
 * The message always contains the word "illegal" so a coarse caller can match
 * on it; precise callers (and tests) read {@link code}.
 */
export class IllegalBlockTransitionError extends Error {
  readonly code: IllegalBlockTransitionCode;
  readonly op: "open" | "append" | "close" | "cancel";
  readonly turnId: string;
  readonly clientBlockId: string;

  constructor(opts: {
    code: IllegalBlockTransitionCode;
    op: "open" | "append" | "close" | "cancel";
    turnId: string;
    clientBlockId: string;
  }) {
    super(
      `IllegalBlockTransitionError[${opts.code}]: illegal block ${opts.op} ` +
        `turn=${opts.turnId} clientBlockId=${opts.clientBlockId}`,
    );
    this.name = "IllegalBlockTransitionError";
    this.code = opts.code;
    this.op = opts.op;
    this.turnId = opts.turnId;
    this.clientBlockId = opts.clientBlockId;
  }
}

/* ---------------- Absorbed live-turns types ---------------- */

export interface LiveBlockState {
  blockId: string;
  clientBlockId: string;
  turnId: string;
  agentName: string;
  sessionId: string;
  messageId: string | null;
  blockIndex: number;
  role: string;
  kind: BlockKind;
  source: BlockSource;
  tool?: { id: string; name: string };
  /** Accumulated text delta for text/thinking blocks. */
  text: string;
  /** Accumulated partial_json delta for tool_use input streams. */
  partialJson: string;
  startedAt: number;
}

export interface LiveTurn {
  turnId: string;
  agent: string;
  sessionId: string;
  /** OPEN blocks, keyed by the worker's clientBlockId — the in-flight read
   *  surface (watchdog / snapshot). A block leaves this map the instant it
   *  reaches a terminal state (close / cancel / finalize) and its id is
   *  recorded in {@link closed}. */
  blocks: Map<string, LiveBlockState>;
  /** clientBlockIds that have reached a terminal state this turn. M6 reads
   *  this to reject a delta/close after the block already closed
   *  (BLOCK_ALREADY_CLOSED) and to reject a second `start` for the same id
   *  (BLOCK_ALREADY_STARTED). Cleared with the turn in {@link tearDownTurn}. */
  closed: Set<string>;
  startedAt: number;
}

/* ---------------- Module-private state ---------------- */

const turns = new Map<string, LiveTurn>();

/* ---------------- Module-private accumulator helpers ----------------
 *
 * Absorbed from live-turns.ts. The seq parameter that used to thread
 * through these is gone — the column retires and the SSE event's own
 * `seq` (stamped by eventBus.publish) is the only sequence anyone reads.
 */

interface StartBlockArgs {
  turnId: string;
  agentName: string;
  sessionId: string;
  clientBlockId: string;
  blockId: string;
  messageId: string | null;
  blockIndex: number;
  role: string;
  kind: BlockKind;
  source: BlockSource;
  tool?: { id: string; name: string };
  ts: number;
}

function startBlockInternal(args: StartBlockArgs): LiveBlockState {
  let lt = turns.get(args.turnId);
  if (!lt) {
    lt = {
      turnId: args.turnId,
      agent: args.agentName,
      sessionId: args.sessionId,
      blocks: new Map(),
      closed: new Set(),
      startedAt: args.ts,
    };
    turns.set(args.turnId, lt);
  }
  // M6 sequence guard: a clientBlockId may only be opened once per turn.
  // A re-open while still in-flight, or after the block already closed, is a
  // protocol violation — reject instead of clobbering the accumulator entry.
  if (lt.blocks.has(args.clientBlockId)) {
    throw new IllegalBlockTransitionError({
      code: "BLOCK_ALREADY_STARTED",
      op: "open",
      turnId: args.turnId,
      clientBlockId: args.clientBlockId,
    });
  }
  if (lt.closed.has(args.clientBlockId)) {
    throw new IllegalBlockTransitionError({
      code: "BLOCK_ALREADY_CLOSED",
      op: "open",
      turnId: args.turnId,
      clientBlockId: args.clientBlockId,
    });
  }
  const state: LiveBlockState = {
    blockId: args.blockId,
    clientBlockId: args.clientBlockId,
    turnId: args.turnId,
    agentName: args.agentName,
    sessionId: args.sessionId,
    messageId: args.messageId,
    blockIndex: args.blockIndex,
    role: args.role,
    kind: args.kind,
    source: args.source,
    tool: args.tool,
    text: "",
    partialJson: "",
    startedAt: args.ts,
  };
  lt.blocks.set(args.clientBlockId, state);
  return state;
}

function appendDeltaInternal(
  turnId: string,
  clientBlockId: string,
  delta: { text?: string; partial_json?: string },
): LiveBlockState {
  const lt = turns.get(turnId);
  const b = lt?.blocks.get(clientBlockId);
  if (!b) {
    // M6 sequence guard: distinguish a delta AFTER the block closed
    // (BLOCK_ALREADY_CLOSED) from a delta with NO matching start
    // (BLOCK_NOT_STARTED). Both used to silently no-op.
    throw new IllegalBlockTransitionError({
      code: lt?.closed.has(clientBlockId) === true ? "BLOCK_ALREADY_CLOSED" : "BLOCK_NOT_STARTED",
      op: "append",
      turnId,
      clientBlockId,
    });
  }
  if (typeof delta.text === "string") b.text += delta.text;
  if (typeof delta.partial_json === "string") b.partialJson += delta.partial_json;
  return b;
}

/**
 * Move an in-flight block to its terminal state, removing it from the open
 * `blocks` map and recording its id in `closed`. Throws if the block was never
 * started (BLOCK_NOT_STARTED) or already reached a terminal state
 * (BLOCK_ALREADY_CLOSED) — the latter is exactly the double-close that used to
 * silently no-op (and, pre-this-fix, could fire a dup-key INSERT). `op`
 * distinguishes the close vs cancel path in the thrown error for diagnosis.
 */
function finishBlockInternal(
  turnId: string,
  clientBlockId: string,
  op: "close" | "cancel",
): LiveBlockState {
  const lt = turns.get(turnId);
  const b = lt?.blocks.get(clientBlockId);
  if (!b) {
    throw new IllegalBlockTransitionError({
      code: lt?.closed.has(clientBlockId) === true ? "BLOCK_ALREADY_CLOSED" : "BLOCK_NOT_STARTED",
      op,
      turnId,
      clientBlockId,
    });
  }
  lt!.blocks.delete(clientBlockId);
  lt!.closed.add(clientBlockId);
  return b;
}

/**
 * Best-effort content_json assembly for an in-flight block whose worker
 * died before sending block-stop. Used by `finalize`. Lifted verbatim
 * from the old `finalizeLiveBlockContent` in lifecycle.ts.
 */
function finalizeLiveBlockContent(live: LiveBlockState): string {
  if (live.kind === "text" || live.kind === "thinking") {
    return JSON.stringify({ text: live.text });
  }
  if (live.kind === "tool_use") {
    let input: unknown = {};
    if (live.partialJson && live.partialJson.length > 0) {
      try {
        input = JSON.parse(live.partialJson);
      } catch {
        input = { _raw: live.partialJson };
      }
    }
    return JSON.stringify({
      tool_use_id: live.tool?.id ?? "",
      name: live.tool?.name ?? "",
      input,
    });
  }
  return JSON.stringify({ tool_use_id: live.tool?.id ?? "", text: "", is_error: true });
}

/* ---------------- Public write surface ---------------- */

/**
 * block-start: register the block in the in-memory accumulator and emit
 * the SSE `block_start` event. No DB write (Phase 5 / ADR-024: rows only
 * exist for closed blocks).
 */
export async function open(w: LiveWorker, e: WorkerBlockStart): Promise<void> {
  const sessionId = w.sessionId ?? "__pending__";
  const blockId = randomUUID();
  const ts = Date.now();
  // tool_result arrives in a "user" SDK message but its block is the
  // agent's tool output, so we treat it as role="assistant" — chat
  // persistence keeps tool calls and their results grouped under the
  // assistant's turn.
  const role = "assistant";
  const source: BlockSource = null;

  // M6: run the state-machine guard FIRST. A double-start (BLOCK_ALREADY_STARTED)
  // or restart-after-close (BLOCK_ALREADY_CLOSED) throws here, before the wedge
  // counter bumps and before any SSE is published — so a rejected open emits no
  // spurious `block_start` and doesn't inflate `blocksThisTurn`.
  startBlockInternal({
    turnId: w.turnId,
    agentName: w.agentName,
    sessionId,
    clientBlockId: e.clientBlockId,
    blockId,
    messageId: e.messageId ?? null,
    blockIndex: e.blockIndex,
    role,
    kind: e.kind,
    source,
    tool: e.tool,
    ts,
  });

  // FRI-61 wedge detector: count every block-start (text, thinking,
  // tool_use, tool_result). Caller-visible side effect on the worker.
  w.blocksThisTurn++;

  eventBus.publish({
    v: 1,
    type: "block_start",
    turn_id: w.turnId,
    agent: w.agentName,
    block_id: blockId,
    message_id: e.messageId ?? null,
    block_index: e.blockIndex,
    role,
    kind: e.kind,
    source,
    tool: e.tool,
    ts,
  });
}

/**
 * block-delta: append to the in-memory accumulator and emit the SSE
 * `block_delta` event. No DB write.
 */
export async function append(w: LiveWorker, e: WorkerBlockDelta): Promise<void> {
  const live = appendDeltaInternal(w.turnId, e.clientBlockId, e.delta);
  eventBus.publish({
    v: 1,
    type: "block_delta",
    turn_id: w.turnId,
    agent: w.agentName,
    block_id: live.blockId,
    delta: e.delta,
  });
}

/**
 * block-stop: finish the in-memory entry, INSERT the canonical row, emit
 * `block_complete`. This is the only block-IPC handler that writes a row.
 *
 * Insert-before-publish preserves the ADR-004 ordering: any client that
 * fetches the row on `block_complete` arrival sees it persisted.
 */
export async function close(w: LiveWorker, e: WorkerBlockStop): Promise<void> {
  const ts = Date.now();
  // Throws BLOCK_ALREADY_CLOSED on a double-close and BLOCK_NOT_STARTED on a
  // close-before-start — BEFORE any DB write, so a violation never fabricates a
  // dup-key INSERT. A successful return guarantees this is the block's first
  // and only close: the INSERT below is always a fresh row (ADR-024: the
  // canonical row first exists here, at close, with the schema-default
  // `streaming=false`).
  const live = finishBlockInternal(w.turnId, e.clientBlockId, "close");

  try {
    await insertBlock({
      blockId: live.blockId,
      turnId: w.turnId,
      agentName: w.agentName,
      sessionId: live.sessionId,
      messageId: live.messageId,
      blockIndex: live.blockIndex,
      role: live.role,
      kind: live.kind,
      source: live.source,
      contentJson: e.contentJson,
      status: e.status,
      ts,
    });
  } catch (err) {
    logger.log("warn", "blocks.insert.error", {
      agent: w.agentName,
      blockId: live.blockId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  eventBus.publish({
    v: 1,
    type: "block_complete",
    turn_id: w.turnId,
    agent: w.agentName,
    block_id: live.blockId,
    message_id: live.messageId,
    block_index: live.blockIndex,
    role: live.role,
    kind: live.kind,
    source: live.source,
    content_json: e.contentJson,
    status: e.status,
    ts,
  });
  // FIX_FORWARD 2.8: badge the agent when the block is user-visible chat
  // content (assistant + text + status=complete). The helper filters tool
  // and thinking blocks itself.
  maybeEmitAgentMessage({
    agent: w.agentName,
    turnId: w.turnId,
    blockId: live.blockId,
    role: live.role,
    kind: live.kind,
    source: live.source,
    status: e.status,
    contentJson: e.contentJson,
  });
}

/**
 * block-cancel (FRI-78 follow-up): drop the in-memory entry without
 * persisting a row, and publish `block_canceled` so live clients drop
 * the bubble. Used when a block_start fired but the SDK exited the
 * for-await loop before producing any deltas.
 */
export async function cancel(w: LiveWorker, e: WorkerBlockCancel): Promise<void> {
  // Cancel is a terminal transition like close — reject a cancel-after-terminal
  // (BLOCK_ALREADY_CLOSED) or cancel-before-start (BLOCK_NOT_STARTED) instead of
  // silently dropping the publish.
  const live = finishBlockInternal(w.turnId, e.clientBlockId, "cancel");
  eventBus.publish({
    v: 1,
    type: "block_canceled",
    turn_id: w.turnId,
    agent: w.agentName,
    block_id: live.blockId,
  });
}

/**
 * Read accessor: where would the next block-index for `turnId` land?
 *
 * Returns `{ index: max(in-flight) + 1, turnLive: true }` when the turn is
 * still resident in the in-memory accumulator (an open()/append() has fired
 * for the turn and `endTurn` hasn't dropped it). Returns
 * `{ index: 0, turnLive: false }` when the turn entry is gone — the caller
 * decides what fallback to use (the injectors module's `recordError` uses
 * `9999` per FRI-148 §3, so a synthetic error landing on an already-
 * finalized turn still sorts last in the canonical block table).
 *
 * Lives in the FSM module because the accumulator is module-private. Phase
 * B split the only synthetic writer that needed this accessor (recordError)
 * out into block-injectors.ts; the accessor is the read-only seam between
 * the two modules.
 */
export function peekNextBlockIndex(turnId: string): { index: number; turnLive: boolean } {
  const lt = turns.get(turnId);
  if (!lt) return { index: 0, turnLive: false };
  let max = -1;
  for (const live of lt.blocks.values()) if (live.blockIndex > max) max = live.blockIndex;
  return { index: max + 1, turnLive: true };
}

/**
 * Worker-exit per-block finalize (module-private helper used by
 * {@link tearDownTurn}). For every in-flight block in this worker's turn,
 * persist a best-effort closed row at the supplied terminal status and publish
 * `block_complete`. Called when the worker dies or is archived without sending
 * block-stop for outstanding blocks.
 *
 * Each block's content_json is assembled via {@link finalizeLiveBlockContent}
 * from whatever text/partial_json accumulated. Tool_use blocks with
 * unparseable partial JSON capture it under `_raw`.
 *
 * M6 INSERT-vs-UPDATE — decided INSIDE the module: an in-flight block normally
 * has NO canonical row (ADR-024: open/append never INSERT — the row's first
 * existence is the terminal write), so finalize INSERTs it born-closed
 * (`streaming=false` via the schema default). But a row CAN already exist for
 * this `blockId` (a legacy `streaming` row from the pre-ADR-024 "INSERT at
 * block-start" path, or a migration artefact) — in that case finalize UPDATEs
 * it off `streaming` rather than firing a dup-key INSERT. The old code did an
 * unconditional `updateBlock`, which was a silent zero-row no-op for every
 * normal ADR-024 block; M6 replaces that with an existence-keyed choice so
 * neither failure mode (zero-row UPDATE / dup-key INSERT) is possible. Each
 * finalized block transitions to the terminal `closed` set, so a late
 * close/append after finalize is rejected rather than re-writing.
 *
 * FRI-148 A: the public entrypoint is now {@link tearDownTurn} (the fuse of
 * the old finalize + endTurn pair). This helper stays as the inner per-block
 * loop so the INSERT-vs-UPDATE logic + per-block `block_complete` publish lives
 * exactly once.
 */
async function finalizeInFlightBlocks(
  w: LiveWorker,
  status: "error" | "aborted",
): Promise<void> {
  const lt = turns.get(w.turnId);
  if (!lt) return;
  // Snapshot the in-flight entries before mutating the map inside the loop.
  const inFlight = [...lt.blocks.values()];
  for (const live of inFlight) {
    const ts = Date.now();
    const contentJson = finalizeLiveBlockContent(live);
    // Terminal transition: drop from the open map, record in `closed`. Done
    // before the awaited write so a concurrent close/append on the same id
    // (extremely unlikely on the single-writer queue, but defensive) sees the
    // terminal state immediately.
    lt.blocks.delete(live.clientBlockId);
    lt.closed.add(live.clientBlockId);
    try {
      // INSERT-vs-UPDATE decided here: existing row → UPDATE off streaming;
      // no row (the ADR-024 normal case) → INSERT born-closed.
      const existing = await getBlockById(live.blockId);
      if (existing) {
        await updateBlock(live.blockId, { contentJson, status, ts });
      } else {
        await insertBlock({
          blockId: live.blockId,
          turnId: w.turnId,
          agentName: w.agentName,
          sessionId: live.sessionId,
          messageId: live.messageId,
          blockIndex: live.blockIndex,
          role: live.role,
          kind: live.kind,
          source: live.source,
          contentJson,
          status,
          ts,
        });
      }
    } catch (err) {
      logger.log("warn", "block-stream.finalize.error", {
        agent: w.agentName,
        blockId: live.blockId,
        status,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    eventBus.publish({
      v: 1,
      type: "block_complete",
      turn_id: w.turnId,
      agent: w.agentName,
      block_id: live.blockId,
      message_id: live.messageId,
      block_index: live.blockIndex,
      role: live.role,
      kind: live.kind,
      source: live.source,
      content_json: contentJson,
      status,
      ts,
    });
  }
}

/**
 * Worker-exit teardown for a turn (FRI-148 A: the fused finalize + endTurn).
 * Finalizes every in-flight block at the supplied terminal status (same
 * per-block INSERT-vs-UPDATE + `block_complete` publish as the old `finalize`),
 * then drops the per-turn accumulator entry. Replaces the old two-call pair —
 * the two operations are always done together at every turn-end teardown
 * (turn-complete, error, hard-exit, force-kill), so fusing them removes the
 * "did I remember to call endTurn?" footgun and pins the order at the boundary
 * (writes-then-drop) inside the module.
 *
 * Idempotent on already-torn-down turns: a missing accumulator entry makes
 * `finalizeInFlightBlocks` a no-op and the `turns.delete` redundant.
 */
export async function tearDownTurn(w: LiveWorker, status: "error" | "aborted"): Promise<void> {
  await finalizeInFlightBlocks(w, status);
  turns.delete(w.turnId);
}

/**
 * Archive-only bare end-turn. The archived-preserve branch in
 * `finalizeHardExit` has already finalized rows; this just drops the per-turn
 * accumulator entry. Narrow export so the rest of the codebase only sees
 * {@link tearDownTurn}, preserving the "always finalize, then drop" pairing for
 * every non-archive teardown path.
 */
export function __endTurnForArchivedHardExit(turnId: string): void {
  turns.delete(turnId);
}

/* ---------------- Agent-message notification (FIX_FORWARD 2.8) ---------------- */

/**
 * Publish an `agent_message` SSE event when a user-visible chat content
 * block lands. Filters: assistant + text + status='complete'. Tool /
 * thinking blocks and mail-role-user blocks are skipped (those are
 * mechanism or recipient-visible noise; the assistant's reply is the
 * user-relevant signal).
 *
 * FRI-125: absorbed from lifecycle.ts under the C2 deepening — every
 * block-row-write path that lands user-visible content (close,
 * recordUserBlock) calls this helper after the publish.
 *
 * FRI-148 B: exported so the injectors module (`recordUserBlock`) can
 * call back into the FSM core's user-visible-content fan-out helper. The
 * helper itself stays in block-stream.ts so the FSM's own `close` path
 * doesn't need an outbound import to call it.
 */
export function maybeEmitAgentMessage(opts: {
  agent: string;
  turnId: string;
  blockId: string;
  role: string;
  kind: BlockKind | string;
  source: BlockSource;
  status: string;
  contentJson: string;
}): void {
  if (opts.kind !== "text") return;
  if (opts.status !== "complete") return;
  // F3-A (PR C): badge only on assistant text. Mail blocks (role=user
  // source=mail) are visible in the recipient's chat scroller, but the
  // orchestrator's *response* to the mail is the user-relevant signal —
  // badging both produced phantom counts (mail-block + later assistant
  // reply → two badges per logical event). The assistant reply that
  // follows mail still triggers exactly one badge.
  if (opts.role !== "assistant") return;
  let text = "";
  try {
    const parsed = JSON.parse(opts.contentJson) as { text?: string };
    if (typeof parsed.text === "string") text = parsed.text;
  } catch {
    // Malformed content_json — leave preview undefined.
  }
  const trimmed = text.trim();
  const preview =
    trimmed.length === 0
      ? undefined
      : trimmed.length > 240
        ? trimmed.slice(0, 240).trim() + "…"
        : trimmed;
  eventBus.publish({
    v: 1,
    type: "agent_message",
    agent: opts.agent,
    turn_id: opts.turnId,
    block_id: opts.blockId,
    kind: "block_complete",
    preview,
  });
}

/* ---------------- Public read surface ---------------- */

/**
 * Narrow reader: is `turnId` still resident in the in-memory accumulator?
 * Replaces existence-check drills through the full snapshot — callers that
 * only need "does this turn still have any in-flight state?" should use
 * this, not `__snapshotForTest`.
 */
export function hasLiveTurn(turnId: string): boolean {
  return turns.has(turnId);
}

/**
 * Narrow reader: peek a single in-flight block by `(turnId, clientBlockId)`.
 * Returns the LiveBlockState read-only, or `null` if the turn isn't resident
 * or the block isn't open. Replaces single-field drills through the full
 * snapshot for callers that already know which block they want to inspect.
 */
export function peekLiveBlock(
  turnId: string,
  clientBlockId: string,
): Readonly<LiveBlockState> | null {
  return turns.get(turnId)?.blocks.get(clientBlockId) ?? null;
}

/**
 * Full-graph snapshot of every live turn. Test-only: production code uses the
 * narrow readers ({@link hasLiveTurn}, {@link peekLiveBlock}) — they cover
 * every observed access pattern. The `__` prefix matches the existing
 * `__seedForTest` / `__resetForTest` convention.
 */
export function __snapshotForTest(): LiveTurn[] {
  return [...turns.values()];
}

/* ---------------- Test seam ---------------- */

/** Wipe the in-memory registry between test cases. */
export function __resetForTest(): void {
  turns.clear();
}

/**
 * Seed the in-memory registry directly. Used by absorbed exit-teardown
 * tests that need to set up in-flight state without driving the public
 * IPC handlers. Production code never calls this.
 */
export function __seedForTest(seed: {
  turnId: string;
  agent: string;
  sessionId: string;
  blocks: LiveBlockState[];
  startedAt?: number;
}): void {
  const map = new Map<string, LiveBlockState>();
  for (const b of seed.blocks) map.set(b.clientBlockId, b);
  turns.set(seed.turnId, {
    turnId: seed.turnId,
    agent: seed.agent,
    sessionId: seed.sessionId,
    blocks: map,
    closed: new Set(),
    startedAt: seed.startedAt ?? Date.now(),
  });
}
