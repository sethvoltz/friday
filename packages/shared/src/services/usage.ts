import { sql } from "drizzle-orm";
import { getDb, getPool } from "../db/client.js";
import { usage, usageRequest } from "../db/schema.js";

export interface InsertUsageInput {
  timestamp: string;
  sessionId: string;
  agentName?: string | null;
  agentType?: string | null;
  model?: string | null;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  turnNumber?: number | null;
  durationMs?: number | null;
}

export async function insertUsage(entry: InsertUsageInput): Promise<void> {
  await getDb()
    .insert(usage)
    .values({
      timestamp: new Date(entry.timestamp),
      sessionId: entry.sessionId,
      agentName: entry.agentName ?? null,
      agentType: entry.agentType ?? null,
      model: entry.model ?? null,
      costUsd: entry.costUsd,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheCreationTokens: entry.cacheCreationTokens,
      cacheReadTokens: entry.cacheReadTokens,
      turnNumber: entry.turnNumber ?? null,
      durationMs: entry.durationMs ?? null,
    });
}

export async function bulkInsertUsage(rows: InsertUsageInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  await getDb()
    .insert(usage)
    .values(
      rows.map((e) => ({
        timestamp: new Date(e.timestamp),
        sessionId: e.sessionId,
        agentName: e.agentName ?? null,
        agentType: e.agentType ?? null,
        model: e.model ?? null,
        costUsd: e.costUsd,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        cacheCreationTokens: e.cacheCreationTokens,
        cacheReadTokens: e.cacheReadTokens,
        turnNumber: e.turnNumber ?? null,
        durationMs: e.durationMs ?? null,
      })),
    );
  return rows.length;
}

export interface InsertUsageRequestInput {
  timestamp: string;
  agentName?: string | null;
  sessionId: string;
  turnId: string;
  /** Request index within the turn (0-based, arrival order). */
  seq: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * Persist the per-API-request usage rows for one completed turn (one row per
 * `assistant` message the SDK streamed). Unlike the cumulative `usage` row,
 * these are NOT summed: the LAST (max-`seq`) row's prompt size is the true live
 * context window — see `getLatestContextForAgent`. Batched; a no-op on `[]`.
 */
export async function insertUsageRequests(rows: InsertUsageRequestInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  await getDb()
    .insert(usageRequest)
    .values(
      rows.map((r) => ({
        timestamp: new Date(r.timestamp),
        agentName: r.agentName ?? null,
        sessionId: r.sessionId,
        turnId: r.turnId,
        seq: r.seq,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheCreationTokens: r.cacheCreationTokens,
        cacheReadTokens: r.cacheReadTokens,
      })),
    );
  return rows.length;
}

export async function isUsageEmpty(): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query("SELECT 1 FROM usage LIMIT 1");
  return result.rows.length === 0;
}

export interface UsageEntryRow {
  timestamp: string;
  sessionId: string;
  agentName: string | null;
  agentType: string | null;
  model: string | null;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  turnNumber: number;
  durationMs: number;
}

/** Every usage row in chronological order. The dashboard does day/week/month
 * bucketing in JS to keep local-tz behavior. */
export async function getAllUsageEntries(): Promise<UsageEntryRow[]> {
  const pool = getPool();
  const result = await pool.query<{
    timestamp: Date;
    sessionId: string;
    agentName: string | null;
    agentType: string | null;
    model: string | null;
    costUsd: number | null;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    turnNumber: number;
    durationMs: number;
  }>(`SELECT timestamp,
             session_id              AS "sessionId",
             agent_name              AS "agentName",
             agent_type              AS "agentType",
             model,
             cost_usd                AS "costUsd",
             input_tokens            AS "inputTokens",
             output_tokens           AS "outputTokens",
             cache_creation_tokens   AS "cacheCreationTokens",
             cache_read_tokens       AS "cacheReadTokens",
             COALESCE(turn_number, 0) AS "turnNumber",
             COALESCE(duration_ms, 0) AS "durationMs"
      FROM usage
      ORDER BY timestamp`);
  return result.rows.map((r) => ({
    ...r,
    timestamp: r.timestamp.toISOString(),
  }));
}

/** Usage rows with `timestamp >= sinceIso`, in chronological order. */
export async function getUsageEntriesSince(sinceIso: string): Promise<UsageEntryRow[]> {
  const pool = getPool();
  const result = await pool.query<{
    timestamp: Date;
    sessionId: string;
    agentName: string | null;
    agentType: string | null;
    model: string | null;
    costUsd: number | null;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    turnNumber: number;
    durationMs: number;
  }>(
    `SELECT timestamp,
             session_id              AS "sessionId",
             agent_name              AS "agentName",
             agent_type              AS "agentType",
             model,
             cost_usd                AS "costUsd",
             input_tokens            AS "inputTokens",
             output_tokens           AS "outputTokens",
             cache_creation_tokens   AS "cacheCreationTokens",
             cache_read_tokens       AS "cacheReadTokens",
             COALESCE(turn_number, 0) AS "turnNumber",
             COALESCE(duration_ms, 0) AS "durationMs"
      FROM usage
      WHERE timestamp >= $1
      ORDER BY timestamp`,
    [new Date(sinceIso)],
  );
  return result.rows.map((r) => ({
    ...r,
    timestamp: r.timestamp.toISOString(),
  }));
}

export interface UsageStats {
  turns: number;
  cost: number;
  /** input_tokens + cache_creation + cache_read (matches dashboard semantics). */
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  duration: number;
  cacheRate: number;
  avgCost: number;
}

function emptyUsageStats(): UsageStats {
  return {
    turns: 0,
    cost: 0,
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
    duration: 0,
    cacheRate: 0,
    avgCost: 0,
  };
}

/** Aggregate stats over `[sinceIso, ?)`. `sinceIso` omitted = lifetime. */
export async function getUsageStats(sinceIso?: string): Promise<UsageStats> {
  const pool = getPool();
  const baseSql = `SELECT
        COUNT(*)::int                          AS "turns",
        COALESCE(SUM(cost_usd), 0)::float8     AS "cost",
        COALESCE(SUM(input_tokens), 0)::float8 AS "inputRaw",
        COALESCE(SUM(output_tokens), 0)::float8 AS "output",
        COALESCE(SUM(cache_creation_tokens),0)::float8 AS "cacheCreation",
        COALESCE(SUM(cache_read_tokens), 0)::float8 AS "cacheRead",
        COALESCE(SUM(duration_ms), 0)::float8  AS "duration"
      FROM usage`;
  const result =
    sinceIso === undefined
      ? await pool.query<{
          turns: number;
          cost: number;
          inputRaw: number;
          output: number;
          cacheCreation: number;
          cacheRead: number;
          duration: number;
        }>(baseSql)
      : await pool.query<{
          turns: number;
          cost: number;
          inputRaw: number;
          output: number;
          cacheCreation: number;
          cacheRead: number;
          duration: number;
        }>(`${baseSql} WHERE timestamp >= $1`, [new Date(sinceIso)]);
  const row = result.rows[0];
  if (!row || row.turns === 0) return emptyUsageStats();
  const cacheTotal = row.cacheCreation + row.cacheRead;
  return {
    turns: row.turns,
    cost: row.cost,
    input: row.inputRaw + row.cacheCreation + row.cacheRead,
    output: row.output,
    cacheCreation: row.cacheCreation,
    cacheRead: row.cacheRead,
    duration: row.duration,
    cacheRate: cacheTotal > 0 ? Math.round((row.cacheRead / cacheTotal) * 100) : 0,
    avgCost: row.turns > 0 ? row.cost / row.turns : 0,
  };
}

export interface DailyByModelRow {
  /** Local-tz YYYY-MM-DD. */
  day: string;
  model: string;
  cost: number;
  rawInput: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  turns: number;
}

/** Per-day, per-model aggregates. Buckets by the daemon's local timezone so
 * day boundaries match what the user sees. `sinceIso` omitted = all time. */
export async function getDailyByModel(sinceIso?: string): Promise<DailyByModelRow[]> {
  const pool = getPool();
  // Postgres equivalent of SQLite's date(timestamp, 'localtime'): convert
  // to local tz then truncate to date. Using `current_setting('TimeZone')`
  // matches the daemon's tz (Postgres server tz; align to host tz at
  // setup time if needed).
  const projection = `to_char(timestamp AT TIME ZONE current_setting('TimeZone'), 'YYYY-MM-DD') AS "day",
              COALESCE(model, 'unknown')                                 AS "model",
              COALESCE(SUM(cost_usd), 0)::float8                         AS "cost",
              COALESCE(SUM(input_tokens), 0)::float8                     AS "rawInput",
              COALESCE(SUM(cache_creation_tokens), 0)::float8            AS "cacheCreation",
              COALESCE(SUM(cache_read_tokens), 0)::float8                AS "cacheRead",
              COALESCE(SUM(output_tokens), 0)::float8                    AS "output",
              COUNT(*)::int                                              AS "turns"`;
  if (sinceIso === undefined) {
    const result = await pool.query<DailyByModelRow>(
      `SELECT ${projection} FROM usage GROUP BY "day", model ORDER BY "day"`,
    );
    return result.rows;
  }
  const result = await pool.query<DailyByModelRow>(
    `SELECT ${projection} FROM usage WHERE timestamp >= $1 GROUP BY "day", model ORDER BY "day"`,
    [new Date(sinceIso)],
  );
  return result.rows;
}

/** Total cost summed by agent_name. NULL agent_name (bare/unknown) excluded. */
export async function getCostByAgent(): Promise<Record<string, number>> {
  const pool = getPool();
  const result = await pool.query<{ name: string; cost: number }>(
    `SELECT agent_name AS name, COALESCE(SUM(cost_usd), 0)::float8 AS cost
     FROM usage
     WHERE agent_name IS NOT NULL
     GROUP BY agent_name`,
  );
  const out: Record<string, number> = {};
  for (const r of result.rows) out[r.name] = r.cost;
  return out;
}

export interface ActivityRow {
  timestamp: string;
  costUsd: number | null;
}

export async function getActivityRows(sinceIsoMs: number): Promise<ActivityRow[]> {
  const pool = getPool();
  const since = new Date(sinceIsoMs);
  const result = await pool.query<{ timestamp: Date; costUsd: number | null }>(
    `SELECT timestamp, cost_usd AS "costUsd"
     FROM usage
     WHERE timestamp >= $1
     ORDER BY timestamp`,
    [since],
  );
  return result.rows.map((r) => ({
    timestamp: r.timestamp.toISOString(),
    costUsd: r.costUsd,
  }));
}

export interface SessionStats {
  sessionId: string;
  turnCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  cacheHitRate: number;
  firstTurnAt: string;
  lastTurnAt: string;
  totalDurationMs: number;
}

export async function getSessionStats(sessionId: string): Promise<SessionStats | null> {
  const pool = getPool();
  const result = await pool.query<{
    turn_count: number;
    total_cost: number;
    total_input: number;
    total_output: number;
    total_cache_create: number;
    total_cache_read: number;
    total_duration: number;
    first_at: Date | null;
    last_at: Date | null;
  }>(
    `SELECT
       COUNT(*)::int                          AS turn_count,
       COALESCE(SUM(cost_usd), 0)::float8     AS total_cost,
       COALESCE(SUM(input_tokens), 0)::float8 AS total_input,
       COALESCE(SUM(output_tokens), 0)::float8 AS total_output,
       COALESCE(SUM(cache_creation_tokens),0)::float8 AS total_cache_create,
       COALESCE(SUM(cache_read_tokens), 0)::float8 AS total_cache_read,
       COALESCE(SUM(duration_ms), 0)::float8  AS total_duration,
       MIN(timestamp)                         AS first_at,
       MAX(timestamp)                         AS last_at
     FROM usage WHERE session_id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row || row.turn_count === 0) return null;

  const totalCacheTokens = row.total_cache_create + row.total_cache_read;
  const cacheHitRate =
    totalCacheTokens > 0 ? Math.round((row.total_cache_read / totalCacheTokens) * 100) : 0;

  return {
    sessionId,
    turnCount: row.turn_count,
    totalCostUsd: row.total_cost,
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCacheCreationTokens: row.total_cache_create,
    totalCacheReadTokens: row.total_cache_read,
    cacheHitRate,
    firstTurnAt: row.first_at?.toISOString() ?? "",
    lastTurnAt: row.last_at?.toISOString() ?? "",
    totalDurationMs: row.total_duration,
  };
}

export interface LatestUsageRow {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  timestamp: Date;
}

/**
 * FRI-156 §C: the most recent usage row for an agent, used by the nightly
 * maintenance sweep to estimate live context pressure. The `usage` table is
 * intentionally NOT Zero-replicated (excluded from SYNC_TABLES), so the sweep
 * must read it server-side.
 *
 * When `sessionId` is supplied the lookup is scoped to it, so a cleared or
 * rotated old session's tokens don't trigger a phantom sweep; otherwise it
 * falls back to the latest row for the agent across all sessions. Uses the
 * `usage_agent_ts` index.
 */
export async function getLatestUsageForAgent(
  agentName: string,
  sessionId?: string,
): Promise<LatestUsageRow | null> {
  const pool = getPool();
  const result =
    sessionId === undefined
      ? await pool.query<{
          inputTokens: number;
          outputTokens: number;
          cacheCreationTokens: number;
          cacheReadTokens: number;
          timestamp: Date;
        }>(
          `SELECT input_tokens           AS "inputTokens",
                  output_tokens          AS "outputTokens",
                  cache_creation_tokens  AS "cacheCreationTokens",
                  cache_read_tokens      AS "cacheReadTokens",
                  timestamp
           FROM usage
           WHERE agent_name = $1
           ORDER BY timestamp DESC
           LIMIT 1`,
          [agentName],
        )
      : await pool.query<{
          inputTokens: number;
          outputTokens: number;
          cacheCreationTokens: number;
          cacheReadTokens: number;
          timestamp: Date;
        }>(
          `SELECT input_tokens           AS "inputTokens",
                  output_tokens          AS "outputTokens",
                  cache_creation_tokens  AS "cacheCreationTokens",
                  cache_read_tokens      AS "cacheReadTokens",
                  timestamp
           FROM usage
           WHERE agent_name = $1 AND session_id = $2
           ORDER BY timestamp DESC
           LIMIT 1`,
          [agentName, sessionId],
        );
  return result.rows[0] ?? null;
}

/**
 * The SDK's effective context size for a turn = input + cacheRead +
 * cacheCreation of the latest usage row (output tokens don't re-enter the
 * window). FRI-156 §C: the sweep compares this against the sweep threshold.
 */
export function estimateContextTokens(row: {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}): number {
  return row.inputTokens + row.cacheCreationTokens + row.cacheReadTokens;
}

/**
 * The TRUE live context window for an agent, back-computed from the per-request
 * `usage_request` table. The live window = the prompt size of the FINAL API
 * request of the agent's most-recent turn = that single (max-`seq`) row's
 * `input + cache_read + cache_creation`.
 *
 * This replaces the old `estimateContextTokens(getLatestUsageForAgent(...))`
 * estimate for the nightly sweep. That path summed the per-turn CUMULATIVE
 * `usage` row, whose `cache_read_input_tokens` is re-counted on every API
 * round-trip in a multi-tool-call turn — inflating the estimate to a large
 * multiple of the real window and firing the sweep far below threshold.
 *
 * When `sessionId` is supplied the lookup is scoped to it (so a cleared/rotated
 * old session's rows can't trigger a phantom sweep); otherwise the latest turn
 * across all of the agent's sessions is used. Returns 0 when there are no rows
 * (a never-run or freshly-cleared agent sits below threshold).
 *
 * "Latest turn" is the turn containing the newest-by-timestamp request row; the
 * final request of that turn is its max-`seq` row. Output tokens are excluded
 * (they don't re-enter the window) — matching `estimateContextTokens`.
 */
export async function getLatestContextForAgent(
  agentName: string,
  sessionId?: string,
): Promise<number> {
  const pool = getPool();
  // CTE: find the latest turn (by newest request timestamp) for the agent,
  // optionally scoped to a session, then take that turn's max-`seq` request row
  // and sum its three context components. Both the CTE and the outer lookup
  // carry the same agent (+ optional session) predicate so a turn_id collision
  // across agents/sessions can't pull in a foreign row.
  const scope = sessionId === undefined ? "" : "AND session_id = $2";
  const params = sessionId === undefined ? [agentName] : [agentName, sessionId];
  const result = await pool.query<{ context: number }>(
    `WITH latest_turn AS (
       SELECT turn_id
       FROM usage_request
       WHERE agent_name = $1 ${scope}
       ORDER BY timestamp DESC
       LIMIT 1
     )
     SELECT COALESCE(input_tokens + cache_read_tokens + cache_creation_tokens, 0)::int
              AS "context"
       FROM usage_request
      WHERE agent_name = $1 ${scope}
        AND turn_id = (SELECT turn_id FROM latest_turn)
      ORDER BY seq DESC
      LIMIT 1`,
    params,
  );
  return result.rows[0]?.context ?? 0;
}

// Re-export the table objects for callers that want raw Drizzle access.
export { usage, usageRequest } from "../db/schema.js";
// Re-export the sql helper so consumers can compose ad-hoc queries.
export { sql };
