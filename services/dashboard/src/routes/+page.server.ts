import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  loadConfig,
  CONFIG_PATH,
  ENV_PATH,
  USAGE_LOG_PATH,
  SESSIONS_DIR,
  AGENTS_PATH,
  FRIDAY_DIR,
  type UsageEntry,
  type AgentRegistry,
} from "@friday/shared";
import { listEntries, type MemoryEntry } from "@friday/memory";
import { join } from "node:path";
import type { PageServerLoad } from "./$types";

const NAMES_CACHE_PATH = join(FRIDAY_DIR, "slack-names.json");

// ── Slack name resolution ────────────────────────────────────

function loadBotToken(): string | null {
  if (!existsSync(ENV_PATH)) return null;
  const envContent = readFileSync(ENV_PATH, "utf-8");
  const match = envContent.match(/^SLACK_BOT_TOKEN=(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function loadNamesCache(): Record<string, string> {
  if (!existsSync(NAMES_CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(NAMES_CACHE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveNamesCache(cache: Record<string, string>): void {
  try {
    writeFileSync(NAMES_CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {
    // Best effort
  }
}

/**
 * Resolve Slack channel/DM IDs to human-readable names.
 * Uses a persistent file cache; only calls Slack API for unknown IDs.
 * Returns a map of channelId → display name ("#general", "@seth", etc.)
 */
async function resolveSlackNames(
  channelIds: string[],
): Promise<Record<string, string>> {
  const cache = loadNamesCache();
  const unknown = channelIds.filter((id) => !cache[id]);

  if (unknown.length === 0) return cache;

  const token = loadBotToken();
  if (!token) return cache;

  let dirty = false;

  for (const id of unknown) {
    try {
      if (id.startsWith("D")) {
        // DM — get the conversation info to find the user
        const convRes = await fetch("https://slack.com/api/conversations.info?" + new URLSearchParams({ channel: id }), {
          headers: { Authorization: `Bearer ${token}` },
        });
        const convData = await convRes.json() as any;
        if (convData.ok && convData.channel?.user) {
          // Resolve the user's display name
          const userRes = await fetch("https://slack.com/api/users.info?" + new URLSearchParams({ user: convData.channel.user }), {
            headers: { Authorization: `Bearer ${token}` },
          });
          const userData = await userRes.json() as any;
          if (userData.ok) {
            const name = userData.user?.profile?.display_name
              || userData.user?.real_name
              || userData.user?.name
              || id;
            cache[id] = `@${name}`;
            dirty = true;
          }
        }
      } else {
        // Channel or group
        const res = await fetch("https://slack.com/api/conversations.info?" + new URLSearchParams({ channel: id }), {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json() as any;
        if (data.ok && data.channel?.name) {
          cache[id] = `#${data.channel.name}`;
          dirty = true;
        }
      }
    } catch {
      // Skip — leave unresolved
    }
  }

  if (dirty) saveNamesCache(cache);

  return cache;
}

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

  // Memory entries
  let memories: MemoryEntry[] = [];
  try {
    memories = listEntries();
  } catch {
    // Memory dir may not exist yet
  }

  // Build sessionId → channelId mapping from all sources
  // 1. channels.json has current sessions
  // 2. Usage entries have channelId for every turn (covers old/reset sessions)
  const sessionToChannel: Record<string, string> = {};
  for (const { channelId, sessionId } of sessions) {
    sessionToChannel[sessionId] = channelId;
  }
  for (const e of usageEntries) {
    if (!sessionToChannel[e.sessionId] && e.channelId) {
      sessionToChannel[e.sessionId] = e.channelId;
    }
  }

  // Resolve Slack channel/DM names
  const slackNames = await resolveSlackNames(
    [...new Set(Object.values(sessionToChannel))],
  );

  // Build session → parent mapping
  const orchChannelId = config.slack.orchestratorChannelId;
  const sessionParentMap: Record<string, { label: string; kind: "channel" | "dm" | "agent"; active: boolean }> = {};

  // Determine which sessions are currently active (in channels.json)
  const activeSessionIds = new Set(sessions.map((s) => s.sessionId));

  for (const [sessionId, channelId] of Object.entries(sessionToChannel)) {
    const active = activeSessionIds.has(sessionId);
    const name = slackNames[channelId];

    if (channelId.startsWith("D")) {
      // DM — name will be @username if resolved
      sessionParentMap[sessionId] = {
        label: name ?? `DM (${channelId})`,
        kind: "dm",
        active,
      };
    } else {
      sessionParentMap[sessionId] = {
        label: name ?? `#${channelId}`,
        kind: "channel",
        active,
      };
    }
  }

  // Agent sessions — override with agent lineage info
  for (const [name, entry] of Object.entries(agents)) {
    if (entry.sessionId) {
      const parent = "parent" in entry ? (entry.parent as string) : undefined;
      sessionParentMap[entry.sessionId] = {
        label: parent ? `${parent} → ${name}` : name,
        kind: "agent",
        active: entry.status === "active" || entry.status === "idle",
      };
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
    memories,
    sessionParentMap,
  };
};
