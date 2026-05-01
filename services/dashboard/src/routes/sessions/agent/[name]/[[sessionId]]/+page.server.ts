import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  SESSIONS_DIR,
  loadConfig,
  resolveTranscriptPath,
  parseTranscript,
  getSessionDateRange,
  getIndexedRanges,
  getSessionStats,
  getSessionAggregates,
  type RegistryEntry,
  type Turn,
} from "@friday/shared";
import { logger } from "$lib/server/log";

export interface ScheduledRun {
  sessionId: string;
  firstAt: string;
  lastAt: string;
  isCurrent: boolean;
}
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, parent }) => {
  const { name, sessionId: requestedSessionId } = params;
  const config = loadConfig();

  // Registry inherited from the root layout.
  const { agents } = await parent();

  const entry = agents[name] ?? null;

  // Determine which session to show
  let sessionId = requestedSessionId ?? entry?.sessionId ?? null;

  // Orchestrator's sessionId is tracked in channels.json, not agents.json
  if (!sessionId && entry?.type === "orchestrator") {
    const channelsPath = join(SESSIONS_DIR, "channels.json");
    if (existsSync(channelsPath)) {
      try {
        const channels: Record<string, string> = JSON.parse(readFileSync(channelsPath, "utf-8"));
        const orchChannelId = config.slack.orchestratorChannelId;
        if (orchChannelId && channels[orchChannelId]) {
          sessionId = channels[orchChannelId];
        }
      } catch { /* skip */ }
    }
  }

  // If still no session and the entry tracks former IDs, fall back to the
  // most recent former. (The legacy JSONL fallback matched any session of
  // the same agent type — too broad in practice; the registry is correct.)
  if (!sessionId && entry?.formerSessionIds?.length) {
    sessionId = entry.formerSessionIds[entry.formerSessionIds.length - 1];
  }

  // Load transcript
  let turns: Turn[] = [];
  let totalTurns = 0;

  if (sessionId && entry) {
    const cwdOverride = entry.type === "orchestrator" ? config.agent.workingDirectory : undefined;
    // Build a temporary entry with the requested sessionId (may differ from current)
    const lookupEntry: RegistryEntry = { ...entry, sessionId };
    const jsonlPath = resolveTranscriptPath(lookupEntry, cwdOverride);

    if (jsonlPath && existsSync(jsonlPath)) {
      try {
        turns = await parseTranscript(jsonlPath);
        totalTurns = turns.length;
      } catch (err) {
        logger.log("error", "transcript_parse_failed", {
          path: jsonlPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Session stats — single aggregation query
  let stats: { turns: number; cost: number; firstAt: string; lastAt: string } | null = null;
  if (sessionId) {
    const dbStats = getSessionStats(sessionId);
    if (dbStats) {
      stats = {
        turns: dbStats.turnCount,
        cost: dbStats.totalCostUsd,
        firstAt: dbStats.firstTurnAt,
        lastAt: dbStats.lastTurnAt,
      };
    }
  }

  const isFormer = requestedSessionId != null || (entry?.status === "destroyed");

  // For scheduled agents, build the list of runs (current + formers) for the run picker.
  let scheduledRuns: ScheduledRun[] | null = null;
  if (entry?.type === "scheduled") {
    const cwd = entry.cwd;
    const currentSessionId = entry.sessionId;
    const formerIds = entry.formerSessionIds ?? [];

    // Per-session aggregates pulled in a single GROUP BY query.
    const allIds = currentSessionId ? [currentSessionId, ...formerIds] : [...formerIds];
    const sessionStats = getSessionAggregates(allIds);
    const indexedRanges = getIndexedRanges(allIds);
    scheduledRuns = allIds.map((sid) => {
      const stats = sessionStats.get(sid);
      let firstAt = stats?.firstAt ?? "";
      let lastAt = stats?.lastAt ?? "";
      if (!firstAt) {
        const indexed = indexedRanges.get(sid);
        if (indexed) {
          firstAt = indexed.firstAt;
          lastAt = indexed.lastAt;
        } else {
          const range = getSessionDateRange(sid, cwd);
          if (range) {
            firstAt = range.firstAt;
            lastAt = range.lastAt;
          }
        }
      }
      return {
        sessionId: sid,
        firstAt,
        lastAt,
        isCurrent: sid === currentSessionId,
      };
    });
  }

  return {
    agentName: name,
    entry,
    sessionId,
    turns,
    totalTurns,
    stats,
    isFormer,
    scheduledRuns,
  };
};
