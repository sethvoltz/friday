import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  USAGE_LOG_PATH,
  SESSIONS_DIR,
  FRIDAY_DIR,
  parseTranscript,
  type UsageEntry,
  type Turn,
} from "@friday/shared";
import type { PageServerLoad } from "./$types";

const NAMES_CACHE_PATH = join(FRIDAY_DIR, "slack-names.json");

function loadNamesCache(): Record<string, string> {
  if (!existsSync(NAMES_CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(NAMES_CACHE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export const load: PageServerLoad = async ({ params }) => {
  const { channelId, sessionId: requestedSessionId } = params;

  // Resolve channel name
  const slackNames = loadNamesCache();
  const label = slackNames[channelId] ?? (channelId.startsWith("D") ? `DM (${channelId})` : `#${channelId}`);

  // Determine session ID — from param, or current active session
  let sessionId = requestedSessionId ?? null;

  if (!sessionId) {
    const channelsPath = join(SESSIONS_DIR, "channels.json");
    if (existsSync(channelsPath)) {
      try {
        const channels = JSON.parse(readFileSync(channelsPath, "utf-8"));
        sessionId = channels[channelId] ?? null;
      } catch { /* skip */ }
    }
  }

  // If still no session, find most recent from usage
  if (!sessionId && existsSync(USAGE_LOG_PATH)) {
    const lines = readFileSync(USAGE_LOG_PATH, "utf-8").split("\n").filter((l) => l.trim());
    let latest: { sessionId: string; timestamp: string } | null = null;
    for (const line of lines) {
      try {
        const e: UsageEntry = JSON.parse(line);
        if (e.channelId === channelId && e.sessionType === "bare") {
          if (!latest || e.timestamp > latest.timestamp) {
            latest = { sessionId: e.sessionId, timestamp: e.timestamp };
          }
        }
      } catch { /* skip */ }
    }
    if (latest) sessionId = latest.sessionId;
  }

  // Load transcript — bare sessions use the daemon's working directory as CWD
  let turns: Turn[] = [];
  let totalTurns = 0;

  if (sessionId) {
    // For bare sessions, we need to figure out the CWD used.
    // Bare sessions use config.agent.workingDirectory (orchestrator channel) or
    // config.independentAgent.workingDirectory. We try the most common patterns.
    const { loadConfig } = await import("@friday/shared");
    const config = loadConfig();
    const possibleCwds = [
      config.agent.workingDirectory,
      config.independentAgent?.workingDirectory,
    ].filter(Boolean) as string[];

    for (const cwd of possibleCwds) {
      const encodedCwd = cwd.replace(/\//g, "-");
      const jsonlPath = join(homedir(), ".claude", "projects", encodedCwd, `${sessionId}.jsonl`);
      if (existsSync(jsonlPath)) {
        try {
          turns = await parseTranscript(jsonlPath);
          totalTurns = turns.length;
        } catch { /* skip */ }
        break;
      }
    }
  }

  // Session stats
  let stats: { turns: number; cost: number; firstAt: string; lastAt: string } | null = null;
  if (sessionId && existsSync(USAGE_LOG_PATH)) {
    const lines = readFileSync(USAGE_LOG_PATH, "utf-8").split("\n").filter((l) => l.trim());
    let turnCount = 0;
    let cost = 0;
    let firstAt = "";
    let lastAt = "";
    for (const line of lines) {
      try {
        const e: UsageEntry = JSON.parse(line);
        if (e.sessionId === sessionId) {
          turnCount++;
          cost += e.costUsd ?? 0;
          if (!firstAt) firstAt = e.timestamp;
          lastAt = e.timestamp;
        }
      } catch { /* skip */ }
    }
    if (turnCount > 0) stats = { turns: turnCount, cost, firstAt, lastAt };
  }

  const isFormer = requestedSessionId != null;

  return {
    channelId,
    label,
    sessionId,
    turns,
    totalTurns,
    stats,
    isFormer,
  };
};
