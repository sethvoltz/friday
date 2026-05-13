import { existsSync, readFileSync } from "node:fs";
import {
  CONFIG_PATH,
  HEALTH_PATH,
  SOUL_PATH,
  loadConfig,
  type AgentEntry,
} from "@friday/shared";
import {
  getCostByAgent,
  getDailyByModel,
  getUsageStats,
  type UsageStats,
} from "@friday/shared/services";
import { daemonGet } from "$lib/server/daemon";
import {
  buildActivityByDate,
  buildDailyCost,
  buildTokenViews,
} from "./_aggregations.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const now = new Date();
  const todayStartIso = (() => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  })();
  const weekStartIso = (() => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 6);
    return d.toISOString();
  })();

  const stats: { today: UsageStats; week: UsageStats; all: UsageStats } = {
    today: getUsageStats(todayStartIso),
    week: getUsageStats(weekStartIso),
    all: getUsageStats(),
  };

  const dailyByModel = getDailyByModel();
  const { dailyCost, models } = buildDailyCost(dailyByModel);
  const { views: tokenViews, costSummary } = buildTokenViews(dailyByModel);

  const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const activityByDate = buildActivityByDate(dailyByModel, oneYearAgo);

  const agentCostsRaw = getCostByAgent();
  const agentCosts: Record<string, { cost: number; estimated: boolean }> = {};
  for (const [name, cost] of Object.entries(agentCostsRaw)) {
    agentCosts[name] = { cost, estimated: false };
  }

  let health: {
    pid?: number;
    uptimeSec?: number;
    rssMb?: number;
    ts?: string;
  } | null = null;
  if (existsSync(HEALTH_PATH)) {
    try {
      health = JSON.parse(readFileSync(HEALTH_PATH, "utf8"));
    } catch {
      // ignore
    }
  }

  let agents: AgentEntry[] = [];
  let daemonOnline = false;
  try {
    agents = await daemonGet<AgentEntry[]>("/api/agents");
    daemonOnline = true;
  } catch {
    // daemon down or timed out
  }

  const config = loadConfig();
  const stateFiles: Array<{
    label: string;
    path: string;
    content: string | null;
  }> = [
    {
      label: "resolved",
      path: "Resolved loaded configuration",
      content: JSON.stringify(config, null, 2),
    },
    {
      label: "config",
      path: CONFIG_PATH,
      content: existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null,
    },
    {
      label: "health",
      path: HEALTH_PATH,
      content: existsSync(HEALTH_PATH) ? readFileSync(HEALTH_PATH, "utf8") : null,
    },
    {
      label: "agents",
      path: "/api/agents",
      content: agents.length > 0 ? JSON.stringify(agents, null, 2) : null,
    },
    {
      label: "soul",
      path: SOUL_PATH,
      content: existsSync(SOUL_PATH) ? readFileSync(SOUL_PATH, "utf8") : null,
    },
  ];

  return {
    stats,
    dailyCost,
    models,
    activityByDate,
    tokenViews,
    costSummary,
    agentCosts,
    stateFiles,
    agents,
    health,
    daemonOnline,
  };
};
