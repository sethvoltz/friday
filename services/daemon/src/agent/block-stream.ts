/**
 * block-stream — the deep block-write pipeline (FRI-125).
 *
 * Absorbs the previous {@link ./live-turns.ts} in-memory accumulator, the
 * `writeAndPublish` helper from lifecycle.ts, the `insertErrorBlock` path,
 * and the `finalizeStreamingBlocks` path into a single module that owns
 * the ADR-004/024 invariant: in-memory accumulator updated before SSE
 * emit; on `block_complete`, the canonical row INSERTs with
 * `streaming=false`. There is no per-row `last_event_seq` peek dance
 * anymore — the column retires in the same PR and the dashboard's cursor
 * is fed by the SSE event's own `seq` field (which {@link eventBus}
 * stamps at publish time).
 *
 * Public surface (per FRI-125 §6):
 *
 *   open / append / close / cancel       — the four block-IPC handlers
 *   recordError                          — synthetic error block (was insertErrorBlock)
 *   finalize                             — exit-time teardown (was finalizeStreamingBlocks)
 *   endTurn                              — turn-end teardown (was liveTurns.dropTurn)
 *   snapshot / getLiveTurn               — read surface for watchdog + tests
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

/* ---------------- Absorbed-from-lifecycle types ----------------
 *
 * FRI-125: `ErrorBlockPayload` was defined alongside `insertErrorBlock`
 * in lifecycle.ts. Both moved here under the C2 absorption; the payload
 * type follows the function that consumes it. Exported so worker-error
 * paths in lifecycle.ts can construct one without round-tripping
 * through a defunct re-export.
 */

export interface ErrorBlockPayload {
  code: string;
  headline: string;
  httpStatus?: number;
  retryAfterSeconds?: number;
  requestId?: string;
  rawMessage: string;
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
  /** Keyed by the worker's clientBlockId — natural lookup for delta/stop. */
  blocks: Map<string, LiveBlockState>;
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
      startedAt: args.ts,
    };
    turns.set(args.turnId, lt);
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
): LiveBlockState | null {
  const lt = turns.get(turnId);
  if (!lt) return null;
  const b = lt.blocks.get(clientBlockId);
  if (!b) return null;
  if (typeof delta.text === "string") b.text += delta.text;
  if (typeof delta.partial_json === "string") b.partialJson += delta.partial_json;
  return b;
}

function finishBlockInternal(turnId: string, clientBlockId: string): LiveBlockState | null {
  const lt = turns.get(turnId);
  if (!lt) return null;
  const b = lt.blocks.get(clientBlockId);
  if (!b) return null;
  lt.blocks.delete(clientBlockId);
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
  // FRI-61 wedge detector: count every block-start (text, thinking,
  // tool_use, tool_result). Caller-visible side effect on the worker.
  w.blocksThisTurn++;

  const sessionId = w.sessionId ?? "__pending__";
  const blockId = randomUUID();
  const ts = Date.now();
  // tool_result arrives in a "user" SDK message but its block is the
  // agent's tool output, so we treat it as role="assistant" — chat
  // persistence keeps tool calls and their results grouped under the
  // assistant's turn.
  const role = "assistant";
  const source: BlockSource = null;

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
}

/**
 * block-delta: append to the in-memory accumulator and emit the SSE
 * `block_delta` event. No DB write.
 */
export async function append(w: LiveWorker, e: WorkerBlockDelta): Promise<void> {
  const live = appendDeltaInternal(w.turnId, e.clientBlockId, e.delta);
  if (!live) return;
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
  const live = finishBlockInternal(w.turnId, e.clientBlockId);
  if (!live) return;

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
}

/**
 * block-cancel (FRI-78 follow-up): drop the in-memory entry without
 * persisting a row, and publish `block_canceled` so live clients drop
 * the bubble. Used when a block_start fired but the SDK exited the
 * for-await loop before producing any deltas.
 */
export async function cancel(w: LiveWorker, e: WorkerBlockCancel): Promise<void> {
  const live = finishBlockInternal(w.turnId, e.clientBlockId);
  if (!live) return;
  eventBus.publish({
    v: 1,
    type: "block_canceled",
    turn_id: w.turnId,
    agent: w.agentName,
    block_id: live.blockId,
  });
}

/**
 * Synthesize an error block for the current turn (FRI-12 path).
 * Persists one row with `kind="error"` + `status="complete"`, then
 * publishes the matching `block_start` + `block_complete` pair so the
 * dashboard materializes the error bubble.
 *
 * Idempotent at the row level via `block_id` uniqueness. The
 * block_index is `max(existing in-flight) + 1` when the turn is still
 * live in the accumulator, else `9999` (post-finalize fallback).
 */
export async function recordError(
  w: LiveWorker,
  payload: ErrorBlockPayload,
): Promise<{ blockId: string } | null> {
  const sessionId = w.sessionId ?? "__pending__";
  const blockId = randomUUID();
  const ts = Date.now();
  const lt = turns.get(w.turnId);
  let blockIndex = 9999;
  if (lt) {
    let max = -1;
    for (const live of lt.blocks.values()) {
      if (live.blockIndex > max) max = live.blockIndex;
    }
    if (max >= 0) blockIndex = max + 1;
  }
  const contentJson = JSON.stringify(payload);

  try {
    await insertBlock({
      blockId,
      turnId: w.turnId,
      agentName: w.agentName,
      sessionId,
      messageId: null,
      blockIndex,
      role: "assistant",
      kind: "error",
      source: null,
      contentJson,
      status: "complete",
      ts,
    });
  } catch (err) {
    logger.log("warn", "blocks.error.insert.fail", {
      agent: w.agentName,
      turnId: w.turnId,
      blockId,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  eventBus.publish({
    v: 1,
    type: "block_start",
    turn_id: w.turnId,
    agent: w.agentName,
    block_id: blockId,
    message_id: null,
    block_index: blockIndex,
    role: "assistant",
    kind: "error",
    source: null,
    ts,
  });
  eventBus.publish({
    v: 1,
    type: "block_complete",
    turn_id: w.turnId,
    agent: w.agentName,
    block_id: blockId,
    message_id: null,
    block_index: blockIndex,
    role: "assistant",
    kind: "error",
    source: null,
    content_json: contentJson,
    status: "complete",
    ts,
  });
  return { blockId };
}

/**
 * Worker-exit teardown: for every in-flight block in this worker's turn,
 * persist a best-effort closed row at the supplied terminal status and
 * publish `block_complete`. Called when the worker dies or is archived
 * without sending block-stop for outstanding blocks.
 *
 * Each block's content_json is assembled via {@link finalizeLiveBlockContent}
 * from whatever text/partial_json accumulated. Tool_use blocks with
 * unparseable partial JSON capture it under `_raw`.
 *
 * This walks the in-flight map and does best-effort `updateBlock` per
 * entry; the row may or may not exist (per Phase 5 / ADR-024 it doesn't
 * exist for SDK-streamed blocks, since open/append don't INSERT). The
 * caller should typically follow with {@link endTurn}.
 */
export async function finalize(w: LiveWorker, status: "error" | "aborted"): Promise<void> {
  const lt = turns.get(w.turnId);
  if (!lt) return;
  for (const live of lt.blocks.values()) {
    const ts = Date.now();
    const contentJson = finalizeLiveBlockContent(live);
    try {
      await updateBlock(live.blockId, {
        contentJson,
        status,
        ts,
      });
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
 * Turn-end signal (was `liveTurns.dropTurn`). Removes the per-turn
 * accumulator entry. Called from the daemon's turn-lifecycle paths
 * (exit, error, turn-complete) after any required {@link finalize}.
 */
export function endTurn(turnId: string): void {
  turns.delete(turnId);
}

/* ---------------- Public read surface ---------------- */

/**
 * Snapshot of every live turn, primarily for the watchdog's stall/wedge
 * scans. Returns the actual LiveTurn references — callers should treat
 * them as read-only.
 */
export function snapshot(): LiveTurn[] {
  return [...turns.values()];
}

/** Read-only lookup by turnId. */
export function getLiveTurn(turnId: string): LiveTurn | null {
  return turns.get(turnId) ?? null;
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
    startedAt: seed.startedAt ?? Date.now(),
  });
}
