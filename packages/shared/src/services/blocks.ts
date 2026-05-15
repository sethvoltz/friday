import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import { getDb, getRawDb } from "../db/client.js";
import * as schema from "../db/schema.js";

export type BlockKind = "text" | "thinking" | "tool_use" | "tool_result";
export type BlockStatus =
  | "streaming"
  | "complete"
  | "aborted"
  | "error"
  /** User block accepted by the daemon but still sitting in the worker's
   *  `nextPrompts` FIFO behind an in-flight turn. Re-stamped to `complete`
   *  with a fresh `ts` when the worker dispatches it (block_meta_update). */
  | "queued";
export type BlockSource =
  | "user_chat"
  | "mail"
  | "queue_inject"
  | "sdk"
  /** Initial seed topic from `/scratch <topic>` — the bare agent's first turn. */
  | "scratch"
  /** Initial prompt from `POST /api/agents` (builder / helper / bare spawn). */
  | "agent_spawn"
  /** Task prompt fired by the scheduler at each cron tick. */
  | "schedule"
  /** Watchdog-injected notice when a stalled worker is reforked. */
  | "refork_notice"
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

/** DELETE a block row. Used by the queued-message cancel endpoint — the
 *  user's draft was never seen by the LLM, so we discard the row entirely
 *  rather than leaving an `aborted` ghost in the transcript. Returns true
 *  if a row was deleted. */
export function deleteBlockById(blockId: string): boolean {
  const db = getDb();
  const res = db
    .delete(schema.blocks)
    .where(eq(schema.blocks.blockId, blockId))
    .run();
  return (res.changes ?? 0) > 0;
}

/** Return all blocks currently in `status='queued'`, oldest first. Used by
 *  the daemon's boot-time rehydration pass to re-seed each worker's
 *  `nextPrompts` FIFO so a daemon restart doesn't silently drop user
 *  drafts that the dashboard already acknowledged. */
export function listQueuedUserBlocks(): BlockRow[] {
  const db = getDb();
  return db
    .select()
    .from(schema.blocks)
    .where(eq(schema.blocks.status, "queued"))
    .orderBy(asc(schema.blocks.ts))
    .all() as BlockRow[];
}

/** Look up a user block (role='user', source='user_chat') by its turn id.
 *  Returns null when the turn doesn't have a user-chat block — covers
 *  mail-injected turns and turns whose user block was already cancelled. */
export function getUserChatBlockByTurnId(turnId: string): BlockRow | null {
  const db = getDb();
  const r = db
    .select()
    .from(schema.blocks)
    .where(
      and(
        eq(schema.blocks.turnId, turnId),
        eq(schema.blocks.role, "user"),
        eq(schema.blocks.source, "user_chat"),
      ),
    )
    .get();
  return (r ?? null) as BlockRow | null;
}

/**
 * Look up a text or thinking block by its natural key
 * `(session_id, message_id, kind)`. Used by JSONL recovery
 * (FIX_FORWARD 1.3) to dedup against blocks already written by the live
 * worker.
 *
 * `block_index` is intentionally NOT part of the key. The live worker
 * stamps the SDK stream's `e.index` (position within the assembled
 * assistant message — so thinking=0, text=1 in a thinking+text reply),
 * but the SDK persists JSONL as one entry per content block, each
 * entry's `content` array starting fresh at `index: 0`. The recovery
 * walker reads its position from `msg.content.forEach((_, idx))`, which
 * is always 0 within a split entry. The two indices therefore disagree
 * for any message with more than one block, and including `block_index`
 * in the dedup key caused recovery to insert a parallel row for the
 * same logical content (FRI-4).
 *
 * `kind` stays in the key because thinking and text legitimately
 * coexist in a single message and need separate rows. Multiple
 * same-kind blocks in one assistant message are not produced by the
 * Anthropic API in practice; if that ever changes, this dedup would
 * collapse them — accept that trade vs. the simpler alternative of
 * carrying an order-tracking counter across JSONL entries.
 *
 * Tool_use and tool_result blocks have a stronger natural key
 * (`tool_use_id`) — see `getToolUseByToolUseId` and
 * `getToolResultByToolUseId`. Use those instead of this function for
 * those kinds.
 */
export function getBlockByNaturalKey(
  sessionId: string,
  messageId: string,
  kind: string,
): BlockRow | null {
  const db = getDb();
  const r = db
    .select()
    .from(schema.blocks)
    .where(
      and(
        eq(schema.blocks.sessionId, sessionId),
        eq(schema.blocks.messageId, messageId),
        eq(schema.blocks.kind, kind),
      ),
    )
    .get();
  return (r ?? null) as BlockRow | null;
}

/**
 * Look up a `tool_use` block by (session_id, tool_use_id). The Claude SDK
 * splits a multi-block assistant message into one JSONL entry per content
 * block, each starting fresh at `index: 0`. The live IPC path, in
 * contrast, writes tool_use at the SDK-stream's global `e.index` (e.g.,
 * `1` if a thinking block precedes it). So the `(message_id, block_index)`
 * coordinates of a tool_use block in JSONL and the same block in DB don't
 * line up. The Anthropic API's `tool_use_id` is the stable cross-reference
 * (it appears identically in JSONL `id` and in DB `content_json.tool_use_id`).
 *
 * Used by jsonl-recovery's tool_use reconcile path so recovery dedup against
 * live-IPC rows works regardless of streaming-chunk boundaries.
 */
export function getToolUseByToolUseId(
  sessionId: string,
  toolUseId: string,
): BlockRow | null {
  const db = getDb();
  const r = db
    .select()
    .from(schema.blocks)
    .where(
      and(
        eq(schema.blocks.sessionId, sessionId),
        eq(schema.blocks.kind, "tool_use"),
        sql`json_extract(${schema.blocks.contentJson}, '$.tool_use_id') = ${toolUseId}`,
      ),
    )
    .get();
  return (r ?? null) as BlockRow | null;
}

/**
 * Look up a `tool_result` block by (session_id, tool_use_id). Tool_result
 * entries in the Claude SDK's JSONL never carry a `message.id` (they're
 * appended to user-role messages whose ids are generated only at flush
 * time), so the (sessionId, messageId, blockIndex) natural key used by
 * `getBlockByNaturalKey` doesn't match. The `tool_use_id` inside
 * `content_json` is the stable cross-reference here: the Anthropic API
 * mints one per tool call and uses it to pair use ↔ result.
 *
 * Used by jsonl-recovery's tool_result reconcile path so the recovery
 * pass is idempotent even when message_id is null in both JSONL and DB.
 */
export function getToolResultByToolUseId(
  sessionId: string,
  toolUseId: string,
): BlockRow | null {
  const db = getDb();
  // json_extract reads the tool_use_id out of the content_json blob. SQLite
  // built-in JSON1 is available everywhere we run (better-sqlite3 ships it).
  const r = db
    .select()
    .from(schema.blocks)
    .where(
      and(
        eq(schema.blocks.sessionId, sessionId),
        eq(schema.blocks.kind, "tool_result"),
        sql`json_extract(${schema.blocks.contentJson}, '$.tool_use_id') = ${toolUseId}`,
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

/** All blocks belonging to a given turn, ordered by insert id. Used by
 *  the Resume endpoint (FRI-12) to recover the original user prompt
 *  from a turn that errored, so the user's "Resume" CTA can re-dispatch
 *  the same prompt under the same turn_id. */
export function listBlocksByTurn(turnId: string): BlockRow[] {
  const db = getDb();
  return db
    .select()
    .from(schema.blocks)
    .where(eq(schema.blocks.turnId, turnId))
    .orderBy(asc(schema.blocks.id))
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
  /** When set, restrict the result to a single SDK session (FIX_FORWARD 3.7
   *  — past-session view). */
  sessionId?: string;
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
    // matchBlocks doesn't filter by session today — apply post-hoc so the
    // /jump <term> search in a past-session view stays scoped.
    const filtered = opts.sessionId
      ? rows.filter((r) => r.sessionId === opts.sessionId)
      : rows;
    return { blocks: filtered, lastEventSeq: maxSeq(filtered) };
  }
  if (typeof opts.aroundTs === "number") {
    return fetchAroundTs(opts);
  }
  if (opts.beforeBlockId) {
    const anchor = getBlockById(opts.beforeBlockId);
    if (!anchor) return { blocks: [], lastEventSeq: 0 };
    const rows = listBlocks({
      agentName: opts.agentName,
      sessionId: opts.sessionId,
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
      sessionId: opts.sessionId,
      afterId: anchor.id,
      limit: clampLimit(opts.limit),
      ascending: true,
    });
    return { blocks: rows, lastEventSeq: maxSeq(rows) };
  }
  const rows = listBlocks({
    agentName: opts.agentName,
    sessionId: opts.sessionId,
    limit: clampLimit(opts.limit),
  });
  return { blocks: rows, lastEventSeq: maxSeq(rows) };
}

function fetchAroundTs(opts: FetchBlocksOpts): FetchBlocksResult {
  const aroundTs = opts.aroundTs as number;
  const db = getDb();
  const beforeLimit = clampLimit(opts.beforeLimit, 10);
  const afterLimit = clampLimit(opts.afterLimit, 40);
  const beforeConds = [
    eq(schema.blocks.agentName, opts.agentName),
    lt(schema.blocks.ts, aroundTs),
  ];
  const afterConds = [
    eq(schema.blocks.agentName, opts.agentName),
    gt(schema.blocks.ts, aroundTs - 1),
  ];
  if (opts.sessionId) {
    beforeConds.push(eq(schema.blocks.sessionId, opts.sessionId));
    afterConds.push(eq(schema.blocks.sessionId, opts.sessionId));
  }
  const beforeRows = db
    .select()
    .from(schema.blocks)
    .where(and(...beforeConds))
    .orderBy(desc(schema.blocks.ts))
    .limit(beforeLimit)
    .all() as BlockRow[];
  const afterRows = db
    .select()
    .from(schema.blocks)
    .where(and(...afterConds))
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

/* ---------------- Agent-session summaries (FIX_FORWARD G) ---------------- */

export interface AgentSessionSummary {
  sessionId: string;
  firstTs: number;
  lastTs: number;
  /** Number of distinct turns observed in this session. Each turn may
   *  contain many blocks; the count here is the number of unique turn
   *  ids, which corresponds to "rounds of interaction". */
  turnCount: number;
}

/**
 * Distinct sessions for an agent, sorted most-recent first. Used by the
 * sidebar to expand an agent row into its prior sessions list. Ported
 * to the `blocks` table at FIX_FORWARD G — the legacy `turns`-table
 * implementation stopped growing post-WS-1.
 */
export function listAgentSessions(agentName: string): AgentSessionSummary[] {
  const db = getDb();
  const rows = db
    .select({
      sessionId: schema.blocks.sessionId,
      firstTs: sql<number>`MIN(${schema.blocks.ts})`,
      lastTs: sql<number>`MAX(${schema.blocks.ts})`,
      turnCount: sql<number>`COUNT(DISTINCT ${schema.blocks.turnId})`,
    })
    .from(schema.blocks)
    .where(eq(schema.blocks.agentName, agentName))
    .groupBy(schema.blocks.sessionId)
    .orderBy(desc(sql<number>`MAX(${schema.blocks.ts})`))
    .all();
  return rows as AgentSessionSummary[];
}

/**
 * Distinct session counts keyed by agent name. One query supplying
 * counts for the entire registry, so `/api/agents` can decide which
 * rows show an expand-history button without N+1 follow-up calls.
 */
export function sessionCountsByAgent(): Record<string, number> {
  const db = getDb();
  const rows = db
    .select({
      agentName: schema.blocks.agentName,
      count: sql<number>`COUNT(DISTINCT ${schema.blocks.sessionId})`,
    })
    .from(schema.blocks)
    .groupBy(schema.blocks.agentName)
    .all();
  const out: Record<string, number> = {};
  for (const r of rows as Array<{ agentName: string | null; count: number }>) {
    if (r.agentName) out[r.agentName] = r.count;
  }
  return out;
}
