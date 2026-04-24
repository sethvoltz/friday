import { readFileSync, existsSync } from "node:fs";
import {
  loadConfig,
  CONFIG_PATH,
  USAGE_LOG_PATH,
  SESSIONS_DIR,
  AGENTS_PATH,
  FRIDAY_DIR,
  type UsageEntry,
  type AgentRegistry,
} from "@friday/shared";
import { join } from "node:path";
import type { PageServerLoad } from "./$types";

interface HealthData {
  pid: number;
  startedAt: string;
  lastHeartbeat: string;
  uptimeMs: number;
}

interface SessionEntry {
  channelId: string;
  sessionId: string;
}

export const load: PageServerLoad = async () => {
  // Config
  const configExists = existsSync(CONFIG_PATH);
  const config = loadConfig();

  // Health
  const healthPath = join(FRIDAY_DIR, "health.json");
  let health: HealthData | null = null;
  let daemonOnline = false;
  if (existsSync(healthPath)) {
    try {
      health = JSON.parse(readFileSync(healthPath, "utf-8"));
      // Consider online if heartbeat is < 60s old
      if (health) {
        const age = Date.now() - new Date(health.lastHeartbeat).getTime();
        daemonOnline = age < 60_000;
      }
    } catch {
      // Malformed
    }
  }

  // Usage entries
  const usageEntries: UsageEntry[] = [];
  if (existsSync(USAGE_LOG_PATH)) {
    const lines = readFileSync(USAGE_LOG_PATH, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    for (const line of lines) {
      try {
        usageEntries.push(JSON.parse(line));
      } catch {
        // skip
      }
    }
  }

  // Sessions
  const sessions: SessionEntry[] = [];
  const channelsPath = join(SESSIONS_DIR, "channels.json");
  if (existsSync(channelsPath)) {
    try {
      const raw = JSON.parse(readFileSync(channelsPath, "utf-8"));
      for (const [channelId, sessionId] of Object.entries(raw)) {
        sessions.push({ channelId, sessionId: sessionId as string });
      }
    } catch {
      // skip
    }
  }

  // Agent registry
  let agents: AgentRegistry = {};
  if (existsSync(AGENTS_PATH)) {
    try {
      agents = JSON.parse(readFileSync(AGENTS_PATH, "utf-8"));
    } catch {
      // skip
    }
  }

  return {
    configExists,
    configPath: CONFIG_PATH,
    config,
    health,
    daemonOnline,
    usageEntries,
    sessions,
    agents,
  };
};
