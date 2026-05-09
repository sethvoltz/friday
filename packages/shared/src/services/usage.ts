import { getDb, getRawDb } from "../db/client.js";
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

export function insertUsage(entry: InsertUsageInput): void {
  getDb()
    .insert(usage)
    .values({
      timestamp: entry.timestamp,
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
    })
    .run();
}

export function bulkInsertUsage(rows: InsertUsageInput[]): number {
  if (rows.length === 0) return 0;
  const raw = getRawDb();
  const stmt = raw.prepare(`
    INSERT INTO usage (
      timestamp, session_id, agent_name, agent_type, model,
      cost_usd, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, turn_number, duration_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = raw.transaction((batch: InsertUsageInput[]) => {
    let n = 0;
    for (const e of batch) {
      stmt.run(
        e.timestamp,
        e.sessionId,
        e.agentName ?? null,
        e.agentType ?? null,
        e.model ?? null,
        e.costUsd,
        e.inputTokens,
        e.outputTokens,
        e.cacheCreationTokens,
        e.cacheReadTokens,
        e.turnNumber ?? null,
        e.durationMs ?? null,
      );
      n++;
    }
    return n;
  });
  return tx(rows);
}

export function isUsageEmpty(): boolean {
  const row = getRawDb().prepare("SELECT 1 FROM usage LIMIT 1").get();
  return row === undefined;
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
export function getAllUsageEntries(): UsageEntryRow[] {
  return getRawDb()
    .prepare(
      `SELECT timestamp,
              session_id              AS sessionId,
              agent_name              AS agentName,
              agent_type              AS agentType,
              model,
              cost_usd                AS costUsd,
              input_tokens            AS inputTokens,
              output_tokens           AS outputTokens,
              cache_creation_tokens   AS cacheCreationTokens,
              cache_read_tokens       AS cacheReadTokens,
              COALESCE(turn_number, 0) AS turnNumber,
              COALESCE(duration_ms, 0) AS durationMs
       FROM usage
       ORDER BY timestamp`,
    )
    .all() as UsageEntryRow[];
}

/** Total cost summed by agent_name. NULL agent_name (bare/unknown) excluded. */
export function getCostByAgent(): Record<string, number> {
  const rows = getRawDb()
    .prepare(
      `SELECT agent_name AS name, COALESCE(SUM(cost_usd), 0) AS cost
       FROM usage
       WHERE agent_name IS NOT NULL
       GROUP BY agent_name`,
    )
    .all() as Array<{ name: string; cost: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.name] = r.cost;
  return out;
}

export interface ActivityRow {
  timestamp: string;
  costUsd: number | null;
}

export function getActivityRows(sinceIsoMs: number): ActivityRow[] {
  const since = new Date(sinceIsoMs).toISOString();
  return getRawDb()
    .prepare(
      `SELECT timestamp, cost_usd AS costUsd
       FROM usage
       WHERE timestamp >= ?
       ORDER BY timestamp`,
    )
    .all(since) as ActivityRow[];
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

export function getSessionStats(sessionId: string): SessionStats | null {
  const row = getRawDb()
    .prepare(
      `SELECT
         COUNT(*)                               AS turn_count,
         COALESCE(SUM(cost_usd), 0)             AS total_cost,
         COALESCE(SUM(input_tokens), 0)         AS total_input,
         COALESCE(SUM(output_tokens), 0)        AS total_output,
         COALESCE(SUM(cache_creation_tokens),0) AS total_cache_create,
         COALESCE(SUM(cache_read_tokens), 0)    AS total_cache_read,
         COALESCE(SUM(duration_ms), 0)          AS total_duration,
         MIN(timestamp)                         AS first_at,
         MAX(timestamp)                         AS last_at
       FROM usage WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        turn_count: number;
        total_cost: number;
        total_input: number;
        total_output: number;
        total_cache_create: number;
        total_cache_read: number;
        total_duration: number;
        first_at: string | null;
        last_at: string | null;
      }
    | undefined;

  if (!row || row.turn_count === 0) return null;

  const totalCacheTokens = row.total_cache_create + row.total_cache_read;
  const cacheHitRate =
    totalCacheTokens > 0
      ? Math.round((row.total_cache_read / totalCacheTokens) * 100)
      : 0;

  return {
    sessionId,
    turnCount: row.turn_count,
    totalCostUsd: row.total_cost,
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCacheCreationTokens: row.total_cache_create,
    totalCacheReadTokens: row.total_cache_read,
    cacheHitRate,
    firstTurnAt: row.first_at ?? "",
    lastTurnAt: row.last_at ?? "",
    totalDurationMs: row.total_duration,
  };
}

export { usage } from "../db/schema.js";
