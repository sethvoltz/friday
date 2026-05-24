import { sql } from "drizzle-orm";
import { getDb, getPool } from "../db/client.js";
import { usage } from "../db/schema.js";

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
        COALESCE(SUM(input_tokens), 0)::int    AS "inputRaw",
        COALESCE(SUM(output_tokens), 0)::int   AS "output",
        COALESCE(SUM(cache_creation_tokens),0)::int AS "cacheCreation",
        COALESCE(SUM(cache_read_tokens), 0)::int    AS "cacheRead",
        COALESCE(SUM(duration_ms), 0)::int     AS "duration"
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
              COALESCE(SUM(input_tokens), 0)::int                        AS "rawInput",
              COALESCE(SUM(cache_creation_tokens), 0)::int               AS "cacheCreation",
              COALESCE(SUM(cache_read_tokens), 0)::int                   AS "cacheRead",
              COALESCE(SUM(output_tokens), 0)::int                       AS "output",
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
       COALESCE(SUM(input_tokens), 0)::int    AS total_input,
       COALESCE(SUM(output_tokens), 0)::int   AS total_output,
       COALESCE(SUM(cache_creation_tokens),0)::int AS total_cache_create,
       COALESCE(SUM(cache_read_tokens), 0)::int    AS total_cache_read,
       COALESCE(SUM(duration_ms), 0)::int     AS total_duration,
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

// Re-export the table object for callers that want raw Drizzle access.
export { usage } from "../db/schema.js";
// Re-export the sql helper so consumers can compose ad-hoc queries.
export { sql };
