/**
 * In-memory in-flight registry (FIX_FORWARD 1.4).
 *
 * The canonical store for chat content is the `blocks` table. While a block
 * is streaming, the daemon holds enough state in memory to:
 *
 *   - accumulate text/thinking deltas into a final content_json without per-
 *     delta DB writes,
 *   - resolve the worker's `clientBlockId` to the canonical UUID we store as
 *     `block_id`,
 *   - track the most-recent SSE seq stamped onto any block in this turn
 *     (enforces ADR-004 ordering at block granularity — FIX_FORWARD 1.10).
 *
 * Lifetime:
 *   - One `LiveTurn` per active `turn_id`. Created on the first `block-start`
 *     for the turn; dropped when the worker emits `turn-complete`.
 *   - On daemon crash/restart the registry is lost. Workers die with the
 *     daemon; tmux respawns it; JSONL boot recovery (FIX_FORWARD 1.3) is the
 *     resilience tier. This is by design.
 */

import type { BlockKind } from "@friday/shared";
import type { BlockSource } from "@friday/shared/services";

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
  startSeq: number;
}

export interface LiveTurn {
  turnId: string;
  agent: string;
  sessionId: string;
  /** Keyed by the worker's clientBlockId — the natural lookup for delta/stop. */
  blocks: Map<string, LiveBlockState>;
  lastEventSeq: number;
  startedAt: number;
}

const turns = new Map<string, LiveTurn>();

export interface StartBlockInput {
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
  seq: number;
}

/**
 * Record a freshly-started block. Creates the parent LiveTurn entry if this
 * is the first block for the turn.
 */
export function startBlock(input: StartBlockInput): LiveBlockState {
  let lt = turns.get(input.turnId);
  if (!lt) {
    lt = {
      turnId: input.turnId,
      agent: input.agentName,
      sessionId: input.sessionId,
      blocks: new Map(),
      lastEventSeq: input.seq,
      startedAt: input.ts,
    };
    turns.set(input.turnId, lt);
  }
  if (input.seq > lt.lastEventSeq) lt.lastEventSeq = input.seq;
  const state: LiveBlockState = {
    blockId: input.blockId,
    clientBlockId: input.clientBlockId,
    turnId: input.turnId,
    agentName: input.agentName,
    sessionId: input.sessionId,
    messageId: input.messageId,
    blockIndex: input.blockIndex,
    role: input.role,
    kind: input.kind,
    source: input.source,
    tool: input.tool,
    text: "",
    partialJson: "",
    startedAt: input.ts,
    startSeq: input.seq,
  };
  lt.blocks.set(input.clientBlockId, state);
  return state;
}

/**
 * Append a delta to the in-memory state for an in-flight block. Returns the
 * updated state, or `null` if no live entry was found (stale delta).
 */
export function appendDelta(
  turnId: string,
  clientBlockId: string,
  delta: { text?: string; partial_json?: string },
  seq: number,
): LiveBlockState | null {
  const lt = turns.get(turnId);
  if (!lt) return null;
  const b = lt.blocks.get(clientBlockId);
  if (!b) return null;
  if (typeof delta.text === "string") b.text += delta.text;
  if (typeof delta.partial_json === "string")
    b.partialJson += delta.partial_json;
  if (seq > lt.lastEventSeq) lt.lastEventSeq = seq;
  return b;
}

/**
 * Mark a block stopped and remove it from the turn's live map. Returns the
 * final state, or `null` if no live entry was found (stale stop).
 */
export function finishBlock(
  turnId: string,
  clientBlockId: string,
  seq: number,
): LiveBlockState | null {
  const lt = turns.get(turnId);
  if (!lt) return null;
  const b = lt.blocks.get(clientBlockId);
  if (!b) return null;
  lt.blocks.delete(clientBlockId);
  if (seq > lt.lastEventSeq) lt.lastEventSeq = seq;
  return b;
}

/** Drop the entire turn entry. Called from the `turn-complete` IPC handler. */
export function dropTurn(turnId: string): void {
  turns.delete(turnId);
}

/** Read-only lookup, primarily for tests / observability. */
export function getLiveTurn(turnId: string): LiveTurn | null {
  return turns.get(turnId) ?? null;
}

/** Read-only snapshot of every live turn — used by tests and watchdog views. */
export function snapshot(): LiveTurn[] {
  return [...turns.values()];
}

/** Number of active turns. */
export function size(): number {
  return turns.size;
}

/** Test seam: wipe the registry between cases. */
export function __resetForTest(): void {
  turns.clear();
}
