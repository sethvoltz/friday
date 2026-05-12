import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import { getDb, getRawDb } from "../db/client.js";
import * as schema from "../db/schema.js";

export type BlockKind = "text" | "thinking" | "tool_use" | "tool_result";
export type BlockStatus = "streaming" | "complete" | "aborted" | "error";
export type BlockSource =
  | "user_chat"
  | "mail"
  | "queue_inject"
  | "sdk"
  | null;

export interface BlockRow {
  id: number;
  blockId: string;
  turnId: string;
  agentName: string;
  sessionId: string;
  messageId: string | null;
  blockIndex: number;
  role: string;
  kind: string;
  source: string | null;
  contentJson: string;
  status: string;
  ts: number;
  lastEventSeq: number;
}

export interface InsertBlockInput {
  blockId: string;
  turnId: string;
  agentName: string;
  sessionId: string;
  messageId?: string | null;
  blockIndex: number;
  role: string;
  kind: BlockKind | string;
  source?: BlockSource;
  contentJson: string;
  status: BlockStatus;
  ts: number;
  lastEventSeq: number;
}

/**
 * INSERT a new block row. Throws on duplicate `blockId` (UNIQUE constraint).
 */
export function insertBlock(input: InsertBlockInput): BlockRow {
  const db = getDb();
  const row = db
    .insert(schema.blocks)
    .values({
      blockId: input.blockId,
      turnId: input.turnId,
      agentName: input.agentName,
      sessionId: input.sessionId,
      messageId: input.messageId ?? null,
      blockIndex: input.blockIndex,
      role: input.role,
      kind: input.kind,
      source: input.source ?? null,
      contentJson: input.contentJson,
      status: input.status,
      ts: input.ts,
      lastEventSeq: input.lastEventSeq,
    })
    .returning()
    .get();
  return row as BlockRow;
}

export interface UpdateBlockPatch {
  contentJson?: string;
  status?: BlockStatus;
  lastEventSeq?: number;
  ts?: number;
  /** Optional new index — defaults to leaving it unchanged. */
  blockIndex?: number;
}

/**
 * UPDATE a block by its stable `blockId`. Returns the new row, or `null` if
 * the block_id wasn't found.
 */
export function updateBlock(
  blockId: string,
  patch: UpdateBlockPatch,
): BlockRow | null {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.blocks)
    .where(eq(schema.blocks.blockId, blockId))
    .get();
  if (!existing) return null;
  const next = {
    contentJson: patch.contentJson ?? existing.contentJson,
    status: patch.status ?? existing.status,
    lastEventSeq: patch.lastEventSeq ?? existing.lastEventSeq,
    ts: patch.ts ?? existing.ts,
    blockIndex: patch.blockIndex ?? existing.blockIndex,
  };
  db.update(schema.blocks)
    .set(next)
    .where(eq(schema.blocks.blockId, blockId))
    .run();
  return { ...(existing as BlockRow), ...next };
}

export function getBlockById(blockId: string): BlockRow | null {
  const db = getDb();
  const r = db
    .select()
    .from(schema.blocks)
    .where(eq(schema.blocks.blockId, blockId))
    .get();
  return (r ?? null) as BlockRow | null;
}

/**
 * Look up a block by its natural key (session_id, message_id, block_index).
 * Used by JSONL boot recovery (FIX_FORWARD 1.3) to dedup against blocks
 * already written by the live worker.
 */
export function getBlockByNaturalKey(
  sessionId: string,
  messageId: string,
  blockIndex: number,
): BlockRow | null {
  const db = getDb();
  const r = db
    .select()
    .from(schema.blocks)
    .where(
      and(
        eq(schema.blocks.sessionId, sessionId),
        eq(schema.blocks.messageId, messageId),
        eq(schema.blocks.blockIndex, blockIndex),
      ),
    )
    .get();
  return (r ?? null) as BlockRow | null;
}

export interface ListBlocksOpts {
  agentName?: string;
  sessionId?: string;
  beforeId?: number;
  afterId?: number;
  limit?: number;
  /** When set, ordering is ascending by id (forward fill). Default desc. */
  ascending?: boolean;
}

export function listBlocks(opts: ListBlocksOpts = {}): BlockRow[] {
  const db = getDb();
  const conds = [] as ReturnType<typeof eq>[];
  if (opts.agentName) conds.push(eq(schema.blocks.agentName, opts.agentName));
  if (opts.sessionId) conds.push(eq(schema.blocks.sessionId, opts.sessionId));
  if (opts.beforeId !== undefined)
    conds.push(lt(schema.blocks.id, opts.beforeId));
  if (opts.afterId !== undefined) conds.push(gt(schema.blocks.id, opts.afterId));
  const base = db.select().from(schema.blocks);
  const filtered = conds.length > 0 ? base.where(and(...conds)) : base;
  return filtered
    .orderBy(opts.ascending ? asc(schema.blocks.id) : desc(schema.blocks.id))
    .limit(opts.limit ?? 50)
    .all() as BlockRow[];
}

/** Most-recent block per agent — used by the per-agent cursor (FIX_FORWARD 1.7). */
export function maxSeqByAgent(agentName: string): number {
  const db = getDb();
  const row = db
    .select({
      maxSeq: sql<number>`COALESCE(MAX(${schema.blocks.lastEventSeq}), 0)`,
    })
    .from(schema.blocks)
    .where(eq(schema.blocks.agentName, agentName))
    .get();
  return row?.maxSeq ?? 0;
}

/* ---------------- Block-fetch API helpers (FIX_FORWARD 1.8) ---------------- */

export interface FetchBlocksOpts {
  agentName: string;
  limit?: number;
  /** Return blocks strictly older than this block_id. */
  beforeBlockId?: string;
  /** Return blocks strictly newer than this block_id. */
  afterBlockId?: string;
  /** Return blocks around this unix-ms timestamp. */
  aroundTs?: number;
  beforeLimit?: number;
  afterLimit?: number;
  /** FTS5 MATCH expression against blocks_fts. */
  match?: string;
}

export interface FetchBlocksResult {
  blocks: BlockRow[];
  /** The largest `last_event_seq` in the result set, or 0 if empty. Clients
   *  use this to seed their per-agent SSE cursor (FIX_FORWARD 1.7). */
  lastEventSeq: number;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

function clampLimit(n: number | undefined, fallback = DEFAULT_LIMIT): number {
  if (!Number.isFinite(n) || (n ?? 0) <= 0) return fallback;
  return Math.min(Math.floor(n as number), MAX_LIMIT);
}

function maxSeq(rows: BlockRow[]): number {
  let m = 0;
  for (const r of rows) if (r.lastEventSeq > m) m = r.lastEventSeq;
  return m;
}

/**
 * Dispatch a /api/agents/:name/blocks query. Modes are mutually exclusive:
 *  - `match`: FTS lookup, returned in score order, capped by `limit`.
 *  - `aroundTs`: blocks before + after a target timestamp (chronological).
 *  - `beforeBlockId` / `afterBlockId`: cursor pagination.
 *  - default (none of the above): most recent `limit` blocks.
 */
export function fetchBlocksByAgent(opts: FetchBlocksOpts): FetchBlocksResult {
  if (opts.match) {
    const rows = matchBlocks({
      agentName: opts.agentName,
      match: opts.match,
      limit: clampLimit(opts.limit, 20),
    });
    return { blocks: rows, lastEventSeq: maxSeq(rows) };
  }
  if (typeof opts.aroundTs === "number") {
    return fetchAroundTs(opts);
  }
  if (opts.beforeBlockId) {
    const anchor = getBlockById(opts.beforeBlockId);
    if (!anchor) return { blocks: [], lastEventSeq: 0 };
    const rows = listBlocks({
      agentName: opts.agentName,
      beforeId: anchor.id,
      limit: clampLimit(opts.limit),
    });
    return { blocks: rows, lastEventSeq: maxSeq(rows) };
  }
  if (opts.afterBlockId) {
    const anchor = getBlockById(opts.afterBlockId);
    if (!anchor) return { blocks: [], lastEventSeq: 0 };
    const rows = listBlocks({
      agentName: opts.agentName,
      afterId: anchor.id,
      limit: clampLimit(opts.limit),
      ascending: true,
    });
    return { blocks: rows, lastEventSeq: maxSeq(rows) };
  }
  const rows = listBlocks({
    agentName: opts.agentName,
    limit: clampLimit(opts.limit),
  });
  return { blocks: rows, lastEventSeq: maxSeq(rows) };
}

function fetchAroundTs(opts: FetchBlocksOpts): FetchBlocksResult {
  const aroundTs = opts.aroundTs as number;
  const db = getDb();
  const beforeLimit = clampLimit(opts.beforeLimit, 10);
  const afterLimit = clampLimit(opts.afterLimit, 40);
  const beforeRows = db
    .select()
    .from(schema.blocks)
    .where(
      and(eq(schema.blocks.agentName, opts.agentName), lt(schema.blocks.ts, aroundTs)),
    )
    .orderBy(desc(schema.blocks.ts))
    .limit(beforeLimit)
    .all() as BlockRow[];
  const afterRows = db
    .select()
    .from(schema.blocks)
    .where(
      and(
        eq(schema.blocks.agentName, opts.agentName),
        gt(schema.blocks.ts, aroundTs - 1),
      ),
    )
    .orderBy(asc(schema.blocks.ts))
    .limit(afterLimit)
    .all() as BlockRow[];
  // Merge in chronological order; before-rows came back DESC.
  const merged = [...beforeRows.reverse(), ...afterRows];
  return { blocks: merged, lastEventSeq: maxSeq(merged) };
}

/** Search blocks_fts. Returns the matching block rows in score order. */
export interface MatchBlocksOpts {
  agentName?: string;
  match: string;
  limit?: number;
}

interface RawBlockRow {
  id: number;
  block_id: string;
  turn_id: string;
  agent_name: string;
  session_id: string;
  message_id: string | null;
  block_index: number;
  role: string;
  kind: string;
  source: string | null;
  content_json: string;
  status: string;
  ts: number;
  last_event_seq: number;
}

function rowFromRaw(r: RawBlockRow): BlockRow {
  return {
    id: r.id,
    blockId: r.block_id,
    turnId: r.turn_id,
    agentName: r.agent_name,
    sessionId: r.session_id,
    messageId: r.message_id,
    blockIndex: r.block_index,
    role: r.role,
    kind: r.kind,
    source: r.source,
    contentJson: r.content_json,
    status: r.status,
    ts: r.ts,
    lastEventSeq: r.last_event_seq,
  };
}

export function matchBlocks(opts: MatchBlocksOpts): BlockRow[] {
  const raw = getRawDb();
  const limit = Math.min(opts.limit ?? 20, 200);
  const rows = opts.agentName
    ? (raw
        .prepare(
          `SELECT b.* FROM blocks b
           JOIN blocks_fts f ON f.rowid = b.id
           WHERE blocks_fts MATCH ? AND b.agent_name = ?
           ORDER BY rank LIMIT ?`,
        )
        .all(opts.match, opts.agentName, limit) as RawBlockRow[])
    : (raw
        .prepare(
          `SELECT b.* FROM blocks b
           JOIN blocks_fts f ON f.rowid = b.id
           WHERE blocks_fts MATCH ?
           ORDER BY rank LIMIT ?`,
        )
        .all(opts.match, limit) as RawBlockRow[]);
  return rows.map(rowFromRaw);
}
