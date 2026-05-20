import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
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
  /** Phase 4.11: now a text UUID (was bigserial number). Same
   *  value as `blockId` for mutator-INSERTed rows; for legacy
   *  daemon-INSERTed rows under the previous bigserial scheme,
   *  the column was flipped to the text representation of the
   *  integer (e.g. "123") so existing rows remain readable but
   *  don't sort chronologically by id alone — see `listBlocks`. */
  id: string;
  blockId: string;
  turnId: string;
  agentName: string;
  sessionId: string;
  messageId: string | null;
  blockIndex: number;
  role: string;
  kind: string;
  source: string | null;
  /** Serialized as JSON text for stable API shape. Underlying column is
   *  jsonb in Postgres; we stringify on read so callers continue parsing
   *  with JSON.parse. Phase 1+ may revisit and pass the parsed object. */
  contentJson: string;
  status: string;
  /** Milliseconds since epoch. */
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
  /** JSON-encoded string of the block payload. */
  contentJson: string;
  status: BlockStatus;
  /** Milliseconds since epoch. */
  ts: number;
  lastEventSeq: number;
}

function rowFromDb(r: typeof schema.blocks.$inferSelect): BlockRow {
  return {
    id: r.id,
    blockId: r.blockId,
    turnId: r.turnId,
    agentName: r.agentName,
    sessionId: r.sessionId,
    messageId: r.messageId,
    blockIndex: r.blockIndex,
    role: r.role,
    kind: r.kind,
    source: r.source,
    contentJson:
      typeof r.contentJson === "string"
        ? r.contentJson
        : JSON.stringify(r.contentJson ?? null),
    status: r.status,
    ts: r.ts.getTime(),
    lastEventSeq: r.lastEventSeq,
  };
}

/**
 * INSERT a new block row. Throws on duplicate `blockId` (UNIQUE constraint).
 */
export async function insertBlock(input: InsertBlockInput): Promise<BlockRow> {
  const db = getDb();
  // contentJson is delivered as a string by callers; parse before inserting
  // so it lands as jsonb in Postgres rather than a stringified scalar.
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.contentJson);
  } catch {
    parsed = input.contentJson;
  }
  const insertedRows = await db
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
      contentJson: parsed,
      status: input.status,
      ts: new Date(input.ts),
      lastEventSeq: input.lastEventSeq,
    })
    .returning();
  return rowFromDb(insertedRows[0]);
}

export interface UpdateBlockPatch {
  contentJson?: string;
  status?: BlockStatus;
  lastEventSeq?: number;
  /** Milliseconds since epoch. */
  ts?: number;
  /** Optional new index — defaults to leaving it unchanged. */
  blockIndex?: number;
}

/**
 * UPDATE a block by its stable `blockId`. Returns the new row, or `null` if
 * the block_id wasn't found.
 */
export async function updateBlock(
  blockId: string,
  patch: UpdateBlockPatch,
): Promise<BlockRow | null> {
  const db = getDb();
  const existingRows = await db
    .select()
    .from(schema.blocks)
    .where(eq(schema.blocks.blockId, blockId))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) return null;
  const updates: Record<string, unknown> = {};
  if (patch.contentJson !== undefined) {
    try {
      updates.contentJson = JSON.parse(patch.contentJson);
    } catch {
      updates.contentJson = patch.contentJson;
    }
  }
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.lastEventSeq !== undefined)
    updates.lastEventSeq = patch.lastEventSeq;
  if (patch.ts !== undefined) updates.ts = new Date(patch.ts);
  if (patch.blockIndex !== undefined) updates.blockIndex = patch.blockIndex;
  if (Object.keys(updates).length === 0) return rowFromDb(existing);
  await db
    .update(schema.blocks)
    .set(updates)
    .where(eq(schema.blocks.blockId, blockId));
  const refetched = await db
    .select()
    .from(schema.blocks)
    .where(eq(schema.blocks.blockId, blockId))
    .limit(1);
  return refetched[0] ? rowFromDb(refetched[0]) : null;
}

export async function getBlockById(blockId: string): Promise<BlockRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.blocks)
    .where(eq(schema.blocks.blockId, blockId))
    .limit(1);
  return rows[0] ? rowFromDb(rows[0]) : null;
}

/** DELETE a block row. Used by the queued-message cancel endpoint — the
 *  user's draft was never seen by the LLM, so we discard the row entirely
 *  rather than leaving an `aborted` ghost in the transcript. Returns true
 *  if a row was deleted. */
export async function deleteBlockById(blockId: string): Promise<boolean> {
  const db = getDb();
  const res = await db
    .delete(schema.blocks)
    .where(eq(schema.blocks.blockId, blockId));
  return (res.rowCount ?? 0) > 0;
}

/** Return all blocks currently in `status='queued'`, oldest first. */
export async function listQueuedUserBlocks(): Promise<BlockRow[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.blocks)
    .where(eq(schema.blocks.status, "queued"))
    .orderBy(asc(schema.blocks.ts));
  return rows.map(rowFromDb);
}

/** Look up a user block (role='user', source='user_chat') by its turn id. */
export async function getUserChatBlockByTurnId(
  turnId: string,
): Promise<BlockRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.blocks)
    .where(
      and(
        eq(schema.blocks.turnId, turnId),
        eq(schema.blocks.role, "user"),
        eq(schema.blocks.source, "user_chat"),
      ),
    )
    .limit(1);
  return rows[0] ? rowFromDb(rows[0]) : null;
}

/**
 * Look up a text or thinking block by its natural key
 * `(session_id, message_id, kind)`. See the long comment on the previous
 * SQLite version (ADR-016 / FRI-4) — semantics unchanged. Tool_use and
 * tool_result use a stronger key (`tool_use_id`); see those helpers.
 */
export async function getBlockByNaturalKey(
  sessionId: string,
  messageId: string,
  kind: string,
): Promise<BlockRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.blocks)
    .where(
      and(
        eq(schema.blocks.sessionId, sessionId),
        eq(schema.blocks.messageId, messageId),
        eq(schema.blocks.kind, kind),
      ),
    )
    .limit(1);
  return rows[0] ? rowFromDb(rows[0]) : null;
}

/** Look up a `tool_use` block by (session_id, tool_use_id). See the long
 *  comment on the previous SQLite version — semantics unchanged. */
export async function getToolUseByToolUseId(
  sessionId: string,
  toolUseId: string,
): Promise<BlockRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.blocks)
    .where(
      and(
        eq(schema.blocks.sessionId, sessionId),
        eq(schema.blocks.kind, "tool_use"),
        sql`${schema.blocks.contentJson}->>'tool_use_id' = ${toolUseId}`,
      ),
    )
    .limit(1);
  return rows[0] ? rowFromDb(rows[0]) : null;
}

/** Look up a `tool_result` block by (session_id, tool_use_id). */
export async function getToolResultByToolUseId(
  sessionId: string,
  toolUseId: string,
): Promise<BlockRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.blocks)
    .where(
      and(
        eq(schema.blocks.sessionId, sessionId),
        eq(schema.blocks.kind, "tool_result"),
        sql`${schema.blocks.contentJson}->>'tool_use_id' = ${toolUseId}`,
      ),
    )
    .limit(1);
  return rows[0] ? rowFromDb(rows[0]) : null;
}

export interface ListBlocksOpts {
  agentName?: string;
  sessionId?: string;
  /** Anchor for `older-than` cursor pagination. Phase 4.11: the
   *  cursor is now a (ts, id) tuple — bigserial id is gone, and a
   *  bare lexical compare on text UUIDs has no chronological
   *  meaning. The anchor's `ts` is the primary sort, `id` only
   *  tiebreaks rows that share a millisecond. */
  beforeAnchor?: { ts: number; id: string };
  /** Anchor for `newer-than` cursor pagination. */
  afterAnchor?: { ts: number; id: string };
  limit?: number;
  /** When set, ordering is ascending by (ts, id) (forward fill).
   *  Default desc (newest first). */
  ascending?: boolean;
}

export async function listBlocks(
  opts: ListBlocksOpts = {},
): Promise<BlockRow[]> {
  const db = getDb();
  const conds = [];
  if (opts.agentName) conds.push(eq(schema.blocks.agentName, opts.agentName));
  if (opts.sessionId) conds.push(eq(schema.blocks.sessionId, opts.sessionId));
  if (opts.beforeAnchor !== undefined) {
    // (ts, id) < (anchorTs, anchorId) lexicographic. Drizzle has no
    // tuple-compare primitive — open-code the OR.
    const a = opts.beforeAnchor;
    conds.push(
      or(
        lt(schema.blocks.ts, new Date(a.ts)),
        and(eq(schema.blocks.ts, new Date(a.ts)), lt(schema.blocks.id, a.id)),
      )!,
    );
  }
  if (opts.afterAnchor !== undefined) {
    const a = opts.afterAnchor;
    conds.push(
      or(
        gt(schema.blocks.ts, new Date(a.ts)),
        and(eq(schema.blocks.ts, new Date(a.ts)), gt(schema.blocks.id, a.id)),
      )!,
    );
  }
  const order = opts.ascending
    ? [asc(schema.blocks.ts), asc(schema.blocks.id)]
    : [desc(schema.blocks.ts), desc(schema.blocks.id)];
  const limit = opts.limit ?? 50;
  const rows =
    conds.length > 0
      ? await db
          .select()
          .from(schema.blocks)
          .where(and(...conds))
          .orderBy(...order)
          .limit(limit)
      : await db
          .select()
          .from(schema.blocks)
          .orderBy(...order)
          .limit(limit);
  return rows.map(rowFromDb);
}

/** All blocks belonging to a given turn, chronologically (ts, id). */
export async function listBlocksByTurn(turnId: string): Promise<BlockRow[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.blocks)
    .where(eq(schema.blocks.turnId, turnId))
    .orderBy(asc(schema.blocks.ts), asc(schema.blocks.id));
  return rows.map(rowFromDb);
}

/** Most-recent block per agent — used by the per-agent cursor (FIX_FORWARD 1.7). */
export async function maxSeqByAgent(agentName: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({
      maxSeq: sql<number>`COALESCE(MAX(${schema.blocks.lastEventSeq}), 0)`.as(
        "maxSeq",
      ),
    })
    .from(schema.blocks)
    .where(eq(schema.blocks.agentName, agentName));
  return rows[0]?.maxSeq ?? 0;
}

/* ---------------- Block-fetch API helpers (FIX_FORWARD 1.8) ---------------- */

export interface FetchBlocksOpts {
  agentName: string;
  /** When set, restrict the result to a single SDK session. */
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
  /** Postgres `plainto_tsquery` expression against the `content_tsv`
   *  generated column on blocks. */
  match?: string;
}

export interface FetchBlocksResult {
  blocks: BlockRow[];
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

export async function fetchBlocksByAgent(
  opts: FetchBlocksOpts,
): Promise<FetchBlocksResult> {
  if (opts.match) {
    const rows = await matchBlocks({
      agentName: opts.agentName,
      match: opts.match,
      limit: clampLimit(opts.limit, 20),
    });
    const filtered = opts.sessionId
      ? rows.filter((r) => r.sessionId === opts.sessionId)
      : rows;
    return { blocks: filtered, lastEventSeq: maxSeq(filtered) };
  }
  if (typeof opts.aroundTs === "number") {
    return fetchAroundTs(opts);
  }
  if (opts.beforeBlockId) {
    const anchor = await getBlockById(opts.beforeBlockId);
    if (!anchor) return { blocks: [], lastEventSeq: 0 };
    const rows = await listBlocks({
      agentName: opts.agentName,
      sessionId: opts.sessionId,
      beforeAnchor: { ts: anchor.ts, id: anchor.id },
      limit: clampLimit(opts.limit),
    });
    return { blocks: rows, lastEventSeq: maxSeq(rows) };
  }
  if (opts.afterBlockId) {
    const anchor = await getBlockById(opts.afterBlockId);
    if (!anchor) return { blocks: [], lastEventSeq: 0 };
    const rows = await listBlocks({
      agentName: opts.agentName,
      sessionId: opts.sessionId,
      afterAnchor: { ts: anchor.ts, id: anchor.id },
      limit: clampLimit(opts.limit),
      ascending: true,
    });
    return { blocks: rows, lastEventSeq: maxSeq(rows) };
  }
  const rows = await listBlocks({
    agentName: opts.agentName,
    sessionId: opts.sessionId,
    limit: clampLimit(opts.limit),
  });
  return { blocks: rows, lastEventSeq: maxSeq(rows) };
}

async function fetchAroundTs(
  opts: FetchBlocksOpts,
): Promise<FetchBlocksResult> {
  const aroundTs = opts.aroundTs as number;
  const db = getDb();
  const beforeLimit = clampLimit(opts.beforeLimit, 10);
  const afterLimit = clampLimit(opts.afterLimit, 40);
  const aroundTsDate = new Date(aroundTs);
  const beforeConds = [
    eq(schema.blocks.agentName, opts.agentName),
    lt(schema.blocks.ts, aroundTsDate),
  ];
  const afterConds = [
    eq(schema.blocks.agentName, opts.agentName),
    gt(schema.blocks.ts, new Date(aroundTs - 1)),
  ];
  if (opts.sessionId) {
    beforeConds.push(eq(schema.blocks.sessionId, opts.sessionId));
    afterConds.push(eq(schema.blocks.sessionId, opts.sessionId));
  }
  const beforeRows = await db
    .select()
    .from(schema.blocks)
    .where(and(...beforeConds))
    .orderBy(desc(schema.blocks.ts))
    .limit(beforeLimit);
  const afterRows = await db
    .select()
    .from(schema.blocks)
    .where(and(...afterConds))
    .orderBy(asc(schema.blocks.ts))
    .limit(afterLimit);
  // Merge in chronological order; before-rows came back DESC.
  const merged = [
    ...beforeRows.reverse().map(rowFromDb),
    ...afterRows.map(rowFromDb),
  ];
  return { blocks: merged, lastEventSeq: maxSeq(merged) };
}

export interface MatchBlocksOpts {
  agentName?: string;
  match: string;
  limit?: number;
}

/**
 * Postgres full-text search against the generated `content_tsv` column on
 * blocks (see schema.ts FTS_SETUP_SQL). The query string is parsed via
 * `plainto_tsquery` for tolerant, prefix-friendly user input.
 */
export async function matchBlocks(
  opts: MatchBlocksOpts,
): Promise<BlockRow[]> {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 20, 200);
  const conds = [
    sql`content_tsv @@ plainto_tsquery('english', ${opts.match})`,
  ];
  if (opts.agentName) {
    conds.push(eq(schema.blocks.agentName, opts.agentName));
  }
  const rows = await db
    .select()
    .from(schema.blocks)
    .where(and(...conds))
    .orderBy(
      sql`ts_rank(content_tsv, plainto_tsquery('english', ${opts.match})) DESC`,
    )
    .limit(limit);
  return rows.map(rowFromDb);
}

/* ---------------- Agent-session summaries (FIX_FORWARD G) ---------------- */

export interface AgentSessionSummary {
  sessionId: string;
  /** Milliseconds since epoch. */
  firstTs: number;
  lastTs: number;
  /** Number of distinct turns observed in this session. */
  turnCount: number;
}

export async function listAgentSessions(
  agentName: string,
): Promise<AgentSessionSummary[]> {
  const db = getDb();
  const rows = await db
    .select({
      sessionId: schema.blocks.sessionId,
      firstTs: sql<Date>`MIN(${schema.blocks.ts})`.as("firstTs"),
      lastTs: sql<Date>`MAX(${schema.blocks.ts})`.as("lastTs"),
      turnCount: sql<number>`COUNT(DISTINCT ${schema.blocks.turnId})::int`.as(
        "turnCount",
      ),
    })
    .from(schema.blocks)
    .where(eq(schema.blocks.agentName, agentName))
    .groupBy(schema.blocks.sessionId)
    .orderBy(desc(sql`MAX(${schema.blocks.ts})`));
  return rows.map((r) => ({
    sessionId: r.sessionId,
    firstTs:
      r.firstTs instanceof Date ? r.firstTs.getTime() : Number(r.firstTs),
    lastTs: r.lastTs instanceof Date ? r.lastTs.getTime() : Number(r.lastTs),
    turnCount: Number(r.turnCount),
  }));
}

/**
 * Distinct session counts keyed by agent name. One query supplying
 * counts for the entire registry.
 */
export async function sessionCountsByAgent(): Promise<Record<string, number>> {
  const db = getDb();
  const rows = await db
    .select({
      agentName: schema.blocks.agentName,
      count: sql<number>`COUNT(DISTINCT ${schema.blocks.sessionId})::int`.as(
        "count",
      ),
    })
    .from(schema.blocks)
    .groupBy(schema.blocks.agentName);
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.agentName) out[r.agentName] = Number(r.count);
  }
  return out;
}
