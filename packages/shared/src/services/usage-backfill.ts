import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, USAGE_LOG_PATH } from "../config.js";
import { bulkInsertUsage, isUsageEmpty, type InsertUsageInput } from "./usage.js";

export interface BackfillResult {
  inserted: number;
  source: string;
  skipped?: false;
}

export interface BackfillSkip {
  inserted: 0;
  source: null;
  skipped: true;
  reason: string;
}

/**
 * One-time import of legacy `~/.friday/usage.jsonl` (or `*.migrated-*`) rows
 * into the `usage` SQLite table. Idempotent: short-circuits when the table
 * already has rows, so it is safe to call on every daemon startup.
 *
 * The legacy JSONL came from old Friday and used `sessionType` instead of
 * `agentType` and carried a Slack `channelId` that the new project drops.
 */
export function backfillUsageFromLegacyJsonl(): BackfillResult | BackfillSkip {
  if (!isUsageEmpty()) {
    return {
      inserted: 0,
      source: null,
      skipped: true,
      reason: "table already populated",
    };
  }

  const source = findLegacySource();
  if (!source) {
    return {
      inserted: 0,
      source: null,
      skipped: true,
      reason: "no legacy usage.jsonl found",
    };
  }

  const text = readFileSync(source, "utf8");
  const rows: InsertUsageInput[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      const ts = r.timestamp;
      const sessionId = r.sessionId;
      if (typeof ts !== "string" || typeof sessionId !== "string") continue;
      rows.push({
        timestamp: ts,
        sessionId,
        agentName: typeof r.agentName === "string" ? r.agentName : null,
        agentType: typeof r.sessionType === "string" ? r.sessionType : null,
        model: typeof r.model === "string" ? r.model : null,
        costUsd: typeof r.costUsd === "number" ? r.costUsd : 0,
        inputTokens: numOr(r.inputTokens, 0),
        outputTokens: numOr(r.outputTokens, 0),
        cacheCreationTokens: numOr(r.cacheCreationTokens, 0),
        cacheReadTokens: numOr(r.cacheReadTokens, 0),
        turnNumber: typeof r.turnNumber === "number" ? r.turnNumber : null,
        durationMs: typeof r.durationMs === "number" ? r.durationMs : null,
      });
    } catch {
      // skip malformed JSON lines
    }
  }
  const inserted = bulkInsertUsage(rows);
  return { inserted, source };
}

function findLegacySource(): string | null {
  if (existsSync(USAGE_LOG_PATH)) return USAGE_LOG_PATH;
  // Fall back to the most recent `usage.jsonl.migrated-YYYY-MM-DD` left over
  // from old Friday's own SQL migration step.
  try {
    const candidates = readdirSync(DATA_DIR)
      .filter((f) => f.startsWith("usage.jsonl.migrated-"))
      .sort()
      .reverse();
    if (candidates.length > 0) return join(DATA_DIR, candidates[0]);
  } catch {
    // DATA_DIR doesn't exist yet — first-run case
  }
  return null;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
