import { and, asc, desc, eq, gt, lt, ne, or, sql } from "drizzle-orm";
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
  /** Boot-time heal for an SDK session wedged on a dangling
   *  `tool_use` (worker died mid-tool-call). See
   *  `services/daemon/src/agent/dangling-tool-use-recovery.ts`. */
  | "recovery_heal"
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
      typeof r.contentJson === "string" ? r.contentJson : JSON.stringify(r.contentJson ?? null),
    status: r.status,
    ts: r.ts.getTime(),
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
    })
    .returning();
  return rowFromDb(insertedRows[0]);
}

export interface UpdateBlockPatch {
  contentJson?: string;
  status?: BlockStatus;
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
  if (patch.ts !== undefined) updates.ts = new Date(patch.ts);
  if (patch.blockIndex !== undefined) updates.blockIndex = patch.blockIndex;
  if (Object.keys(updates).length === 0) return rowFromDb(existing);
  await db.update(schema.blocks).set(updates).where(eq(schema.blocks.blockId, blockId));
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
  const res = await db.delete(schema.blocks).where(eq(schema.blocks.blockId, blockId));
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

export async function listBlocks(opts: ListBlocksOpts = {}): Promise<BlockRow[]> {
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
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

function clampLimit(n: number | undefined, fallback = DEFAULT_LIMIT): number {
  if (!Number.isFinite(n) || (n ?? 0) <= 0) return fallback;
  return Math.min(Math.floor(n as number), MAX_LIMIT);
}

export async function fetchBlocksByAgent(opts: FetchBlocksOpts): Promise<FetchBlocksResult> {
  if (opts.match) {
    const rows = await matchBlocks({
      agentName: opts.agentName,
      match: opts.match,
      limit: clampLimit(opts.limit, 20),
    });
    const filtered = opts.sessionId ? rows.filter((r) => r.sessionId === opts.sessionId) : rows;
    return { blocks: filtered };
  }
  if (typeof opts.aroundTs === "number") {
    return fetchAroundTs(opts);
  }
  if (opts.beforeBlockId) {
    const anchor = await getBlockById(opts.beforeBlockId);
    if (!anchor) return { blocks: [] };
    const rows = await listBlocks({
      agentName: opts.agentName,
      sessionId: opts.sessionId,
      beforeAnchor: { ts: anchor.ts, id: anchor.id },
      limit: clampLimit(opts.limit),
    });
    return { blocks: rows };
  }
  if (opts.afterBlockId) {
    const anchor = await getBlockById(opts.afterBlockId);
    if (!anchor) return { blocks: [] };
    const rows = await listBlocks({
      agentName: opts.agentName,
      sessionId: opts.sessionId,
      afterAnchor: { ts: anchor.ts, id: anchor.id },
      limit: clampLimit(opts.limit),
      ascending: true,
    });
    return { blocks: rows };
  }
  const rows = await listBlocks({
    agentName: opts.agentName,
    sessionId: opts.sessionId,
    limit: clampLimit(opts.limit),
  });
  return { blocks: rows };
}

async function fetchAroundTs(opts: FetchBlocksOpts): Promise<FetchBlocksResult> {
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
  const merged = [...beforeRows.reverse().map(rowFromDb), ...afterRows.map(rowFromDb)];
  return { blocks: merged };
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
export async function matchBlocks(opts: MatchBlocksOpts): Promise<BlockRow[]> {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 20, 200);
  const conds = [sql`content_tsv @@ plainto_tsquery('english', ${opts.match})`];
  if (opts.agentName) {
    conds.push(eq(schema.blocks.agentName, opts.agentName));
  }
  const rows = await db
    .select()
    .from(schema.blocks)
    .where(and(...conds))
    .orderBy(sql`ts_rank(content_tsv, plainto_tsquery('english', ${opts.match})) DESC`)
    .limit(limit);
  return rows.map(rowFromDb);
}

/* ---------------- Agent-session summaries (FIX_FORWARD G) ---------------- */

/** Sentinel session_id the dashboard mutator writes onto user blocks
 *  before the daemon has resolved the SDK's real session id. The
 *  lifecycle session-update sweep (`claimPendingSession`) rewrites
 *  these rows to the real id; historical orphans from before the
 *  sweep landed are excluded from session summaries and the agents
 *  row's `session_count` column so the sidebar doesn't surface them
 *  as a phantom "session" with no real conversation. */
export const PENDING_SESSION_SENTINEL = "__pending__";

export interface AgentSessionSummary {
  sessionId: string;
  /** Milliseconds since epoch. */
  firstTs: number;
  lastTs: number;
  /** Number of distinct turns observed in this session. */
  turnCount: number;
}

export async function listAgentSessions(agentName: string): Promise<AgentSessionSummary[]> {
  const db = getDb();
  // Two fixes folded together:
  //   1. Exclude the `__pending__` sentinel session — historical
  //      orphan rows from the pre-sweep era show as a phantom session
  //      in the sidebar's expand-history list otherwise.
  //   2. Compute `firstTs` / `lastTs` as epoch milliseconds in SQL
  //      via `EXTRACT(EPOCH FROM ...)`. Drizzle's `sql<Date>`
  //      template literal is a TS hint only; the pg driver has no
  //      type parser for aliased aggregate columns of timestamptz, so
  //      the prior code received `undefined` at runtime, fell through
  //      the `instanceof Date` check, called `Number(undefined)`
  //      (= NaN), JSON-serialized as `null`, and rendered as
  //      "Dec 31" client-side (epoch zero in PST). The bigint cast
  //      keeps the value an integer the pg driver returns as a
  //      string we can safely `Number(...)`.
  const rows = await db
    .select({
      sessionId: schema.blocks.sessionId,
      firstTs: sql<string>`(EXTRACT(EPOCH FROM MIN(${schema.blocks.ts})) * 1000)::bigint`.as(
        "firstTs",
      ),
      lastTs: sql<string>`(EXTRACT(EPOCH FROM MAX(${schema.blocks.ts})) * 1000)::bigint`.as(
        "lastTs",
      ),
      turnCount: sql<number>`COUNT(DISTINCT ${schema.blocks.turnId})::int`.as("turnCount"),
    })
    .from(schema.blocks)
    .where(
      and(
        eq(schema.blocks.agentName, agentName),
        ne(schema.blocks.sessionId, PENDING_SESSION_SENTINEL),
      ),
    )
    .groupBy(schema.blocks.sessionId)
    .orderBy(desc(sql`MAX(${schema.blocks.ts})`));
  return rows.map((r) => ({
    sessionId: r.sessionId,
    firstTs: Number(r.firstTs),
    lastTs: Number(r.lastTs),
    turnCount: Number(r.turnCount),
  }));
}

/**
 * Distinct session counts keyed by agent name. One query supplying
 * counts for the entire registry. Excludes the `__pending__` sentinel
 * so the count agrees with what `listAgentSessions` returns to the
 * sidebar.
 */
export async function sessionCountsByAgent(): Promise<Record<string, number>> {
  const db = getDb();
  const rows = await db
    .select({
      agentName: schema.blocks.agentName,
      count: sql<number>`COUNT(DISTINCT ${schema.blocks.sessionId})::int`.as("count"),
    })
    .from(schema.blocks)
    .where(ne(schema.blocks.sessionId, PENDING_SESSION_SENTINEL))
    .groupBy(schema.blocks.agentName);
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.agentName) out[r.agentName] = Number(r.count);
  }
  return out;
}

/**
 * Rewrite the current turn's `__pending__` blocks for an agent to the
 * SDK-minted session id. Called from the daemon's lifecycle
 * `session-update` handler: the dashboard mutator writes user blocks
 * with the `__pending__` sentinel before the worker has announced a
 * session, and the dispatch-listener's pre-worker UPDATE can only
 * rewrite the row when the agent already has a `resumeSessionId` (so
 * a fresh / just-cleared agent's first user block stays at
 * `__pending__`). Worker-side block writes that race the
 * `session-update` IPC also land as `__pending__` via
 * `w.sessionId ?? '__pending__'` in lifecycle.ts.
 *
 * Scope is `(agentName, turnId)`, NOT `(agentName)` alone — historical
 * orphan rows from prior turns where this sweep didn't run must NOT
 * be re-attached to the agent's current SDK session. Conflating past
 * turns into today's fresh session would corrupt the past-sessions
 * list and pull yesterday's user prompts into today's context. Those
 * historical orphans stay at `__pending__` on disk (preserve-over-
 * delete) and are excluded from `listAgentSessions` and
 * `sessionCountsByAgent` so they don't surface in the sidebar.
 *
 * Cross-agent isolation: the WHERE clause is scoped to `agentName`,
 * so agent A's session-update never claims agent B's pending rows.
 *
 * After the rewrite we recompute `agents.session_count` for this
 * agent rather than relying on the INSERT-only trigger. The trigger
 * fires per-row on AFTER INSERT and skips the sentinel, so the
 * sweep's UPDATE (which moves rows OFF the sentinel) is the one
 * event that would have otherwise gone uncounted. Re-deriving from
 * `COUNT(DISTINCT … WHERE != sentinel)` here also self-heals
 * `session_count` if historical orphans are ever migrated.
 *
 * Returns the number of rows updated, for diagnostic logging only.
 */
export async function claimPendingSession(
  agentName: string,
  turnId: string,
  sessionId: string,
): Promise<number> {
  if (sessionId === PENDING_SESSION_SENTINEL) return 0;
  const db = getDb();
  const result = await db
    .update(schema.blocks)
    .set({ sessionId })
    .where(
      and(
        eq(schema.blocks.agentName, agentName),
        eq(schema.blocks.turnId, turnId),
        eq(schema.blocks.sessionId, PENDING_SESSION_SENTINEL),
      ),
    )
    .returning({ blockId: schema.blocks.blockId });
  if (result.length > 0) {
    await db
      .update(schema.agents)
      .set({
        sessionCount: sql`(
          SELECT COUNT(DISTINCT ${schema.blocks.sessionId})::int
          FROM ${schema.blocks}
          WHERE ${schema.blocks.agentName} = ${agentName}
            AND ${schema.blocks.sessionId} <> ${PENDING_SESSION_SENTINEL}
        )`,
      })
      .where(eq(schema.agents.name, agentName));
  }
  return result.length;
}
