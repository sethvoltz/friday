import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfig,
  AGENTS_PATH,
  USAGE_LOG_PATH,
  SESSIONS_DIR,
  FRIDAY_DIR,
  getSessionDateRange,
  type AgentRegistry,
  type RegistryEntry,
  type UsageEntry,
} from "@friday/shared";
import type { LayoutServerLoad } from "./$types";

const NAMES_CACHE_PATH = join(FRIDAY_DIR, "slack-names.json");
const HISTORY_FILE = join(SESSIONS_DIR, "channel-history.json");

function loadNamesCache(): Record<string, string> {
  if (!existsSync(NAMES_CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(NAMES_CACHE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export interface AgentTreeNode {
  name: string;
  entry: RegistryEntry;
  children: AgentTreeNode[];
  /** Start date of the current/active session (ISO string) */
  currentSessionStart: string | null;
  /** Former session IDs with date ranges */
  formerSessions: Array<{ sessionId: string; firstAt: string; lastAt: string; turns: number }>;
}

export interface BareSessionGroup {
  channelId: string;
  label: string;
  kind: "channel" | "dm";
  currentSessionStart: string | null;
  sessions: Array<{ sessionId: string; firstAt: string; lastAt: string; turns: number; active: boolean }>;
}

export const load: LayoutServerLoad = async () => {
  const config = loadConfig();

  // Agent registry
  let agents: AgentRegistry = {};
  if (existsSync(AGENTS_PATH)) {
    try {
      agents = JSON.parse(readFileSync(AGENTS_PATH, "utf-8"));
    } catch { /* skip */ }
  }

  // Usage entries
  const usageEntries: UsageEntry[] = [];
  if (existsSync(USAGE_LOG_PATH)) {
    const lines = readFileSync(USAGE_LOG_PATH, "utf-8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try { usageEntries.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }

  // Current channel sessions
  const channelsPath = join(SESSIONS_DIR, "channels.json");
  let channelSessions: Record<string, string> = {};
  if (existsSync(channelsPath)) {
    try { channelSessions = JSON.parse(readFileSync(channelsPath, "utf-8")); } catch { /* skip */ }
  }

  // Channel history (former sessions from /friday reset)
  let channelHistory: Record<string, string[]> = {};
  if (existsSync(HISTORY_FILE)) {
    try { channelHistory = JSON.parse(readFileSync(HISTORY_FILE, "utf-8")); } catch { /* skip */ }
  }

  // Slack name cache
  const slackNames = loadNamesCache();

  // ── Usage stats by sessionId ────────────────────────────────
  const usageBySession = new Map<string, { firstAt: string; lastAt: string; turns: number }>();
  for (const e of usageEntries) {
    const existing = usageBySession.get(e.sessionId);
    if (existing) {
      existing.turns++;
      existing.lastAt = e.timestamp;
    } else {
      usageBySession.set(e.sessionId, { firstAt: e.timestamp, lastAt: e.timestamp, turns: 1 });
    }
  }

  // ── Build agent tree ────────────────────────────────────────
  const orchChannelId = config.slack.orchestratorChannelId;

  // Resolve the CWD for an agent entry (used for transcript file lookups)
  function agentCwd(entry: RegistryEntry): string | null {
    if (entry.type === "orchestrator") return config.agent.workingDirectory;
    if (entry.type === "builder") return entry.workspace;
    if (entry.type === "agent") return entry.cwd;
    return null;
  }

  function buildNode(name: string, entry: RegistryEntry): AgentTreeNode {
    // Orchestrator's current session is in channels.json, not the registry
    const currentSessionId = entry.sessionId
      ?? (entry.type === "orchestrator" && orchChannelId ? channelSessions[orchChannelId] ?? null : null);

    // Former sessions from registry (backfilled + maintained by daemon)
    const formerIds = entry.formerSessionIds ?? [];
    const cwd = agentCwd(entry);

    const formerSessions = formerIds
      .map((sid) => {
        const stats = usageBySession.get(sid);
        // Fall back to reading dates from the transcript JSONL file
        if (!stats && cwd) {
          const range = getSessionDateRange(sid, cwd);
          if (range) return { sessionId: sid, ...range, turns: 0 };
        }
        return {
          sessionId: sid,
          firstAt: stats?.firstAt ?? "",
          lastAt: stats?.lastAt ?? "",
          turns: stats?.turns ?? 0,
        };
      })
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt));

    const children: AgentTreeNode[] = [];
    if ("children" in entry && Array.isArray(entry.children)) {
      for (const childName of entry.children) {
        const childEntry = agents[childName];
        if (childEntry) {
          children.push(buildNode(childName, childEntry));
        }
      }
    }

    // Also pick up destroyed agents that were children but may have been removed from children array
    for (const [agentName, agentEntry] of Object.entries(agents)) {
      if ("parent" in agentEntry && agentEntry.parent === name && !children.some((c) => c.name === agentName)) {
        children.push(buildNode(agentName, agentEntry));
      }
    }

    // Start date: from usage stats, transcript file, or createdAt
    let currentSessionStart: string | null = null;
    if (currentSessionId) {
      const stats = usageBySession.get(currentSessionId);
      if (stats) {
        currentSessionStart = stats.firstAt;
      } else if (cwd) {
        const range = getSessionDateRange(currentSessionId, cwd);
        currentSessionStart = range?.firstAt ?? entry.createdAt ?? null;
      } else {
        currentSessionStart = entry.createdAt ?? null;
      }
    } else {
      currentSessionStart = entry.createdAt ?? null;
    }

    return { name, entry, children, currentSessionStart, formerSessions };
  }

  // Build tree from orchestrator root
  const orchestratorEntry = agents["orchestrator"];
  const agentTree: AgentTreeNode[] = [];
  if (orchestratorEntry) {
    agentTree.push(buildNode("orchestrator", orchestratorEntry));
  }
  // Add any orphaned builders/agents not under orchestrator
  for (const [name, entry] of Object.entries(agents)) {
    if (name === "orchestrator") continue;
    const parent = "parent" in entry ? entry.parent : null;
    if (!parent || !agents[parent]) {
      if (!agentTree.some((n) => n.name === name)) {
        agentTree.push(buildNode(name, entry));
      }
    }
  }

  // ── Build bare session groups ───────────────────────────────
  const bareByChannel = new Map<string, Map<string, { firstAt: string; lastAt: string; turns: number }>>();
  for (const e of usageEntries) {
    if (e.sessionType === "bare" && e.channelId) {
      if (!bareByChannel.has(e.channelId)) bareByChannel.set(e.channelId, new Map());
      const sessions = bareByChannel.get(e.channelId)!;
      const existing = sessions.get(e.sessionId);
      if (existing) {
        existing.turns++;
        existing.lastAt = e.timestamp;
      } else {
        sessions.set(e.sessionId, { firstAt: e.timestamp, lastAt: e.timestamp, turns: 1 });
      }
    }
  }

  // Also add channel-history entries that may not be in usage (pre-logging resets)
  for (const [channelId, formerIds] of Object.entries(channelHistory)) {
    if (!bareByChannel.has(channelId)) bareByChannel.set(channelId, new Map());
    const sessions = bareByChannel.get(channelId)!;
    for (const sid of formerIds) {
      if (!sessions.has(sid)) {
        sessions.set(sid, { firstAt: "", lastAt: "", turns: 0 });
      }
    }
  }

  const activeSessionIds = new Set(Object.values(channelSessions));
  const orchestratorChannelId = config.slack.orchestratorChannelId;

  const bareSessionGroups: BareSessionGroup[] = [...bareByChannel.entries()]
    .filter(([channelId]) => channelId !== orchestratorChannelId)
    .map(([channelId, sessions]) => {
      const name = slackNames[channelId];
      const activeSession = [...sessions.entries()].find(([sid]) => activeSessionIds.has(sid));
      const activeStats = activeSession ? usageBySession.get(activeSession[0]) : null;
      return {
        channelId,
        label: name ?? (channelId.startsWith("D") ? `DM (${channelId})` : `#${channelId}`),
        kind: (channelId.startsWith("D") ? "dm" : "channel") as "dm" | "channel",
        currentSessionStart: activeStats?.firstAt ?? null,
        sessions: [...sessions.entries()]
          .map(([sessionId, stats]) => ({
            sessionId,
            ...stats,
            active: activeSessionIds.has(sessionId),
          }))
          .sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
      };
    })
    .sort((a, b) => {
      const aLatest = a.sessions[0]?.lastAt ?? "";
      const bLatest = b.sessions[0]?.lastAt ?? "";
      return bLatest.localeCompare(aLatest);
    });

  return {
    agentTree,
    bareSessionGroups,
    config: { workingDirectory: config.agent.workingDirectory },
  };
};
