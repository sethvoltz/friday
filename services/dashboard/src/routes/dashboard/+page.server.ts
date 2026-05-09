import { existsSync, readFileSync } from "node:fs";
import {
  CONFIG_PATH,
  HEALTH_PATH,
  SOUL_PATH,
  loadConfig,
  type AgentEntry,
} from "@friday/shared";
import { getAllUsageEntries, getCostByAgent } from "@friday/shared/services";
import { daemonGet } from "$lib/server/daemon";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const usageEntries = getAllUsageEntries();
  const agentCostsRaw = getCostByAgent();

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
    // daemon down
  }

  const agentCosts: Record<string, { cost: number; estimated: boolean }> = {};
  for (const [name, cost] of Object.entries(agentCostsRaw)) {
    agentCosts[name] = { cost, estimated: false };
  }

  const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const activityByDate: Record<string, { count: number; cost: number }> = {};
  for (const e of usageEntries) {
    const ts = new Date(e.timestamp).getTime();
    if (ts < oneYearAgo) continue;
    const day = new Date(e.timestamp).toLocaleDateString("en-CA");
    if (!activityByDate[day]) activityByDate[day] = { count: 0, cost: 0 };
    activityByDate[day].count++;
    activityByDate[day].cost += e.costUsd ?? 0;
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
    usageEntries,
    agentCosts,
    activityByDate,
    stateFiles,
    agents,
    health,
    daemonOnline,
  };
};
