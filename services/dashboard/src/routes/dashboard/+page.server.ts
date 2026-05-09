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
  type DailyByModelRow,
  type UsageStats,
} from "@friday/shared/services";
import { daemonGet } from "$lib/server/daemon";
import type { PageServerLoad } from "./$types";

type DailyCost = {
  day: string;
  totalCost: number;
  costByModel: Record<string, number>;
  inputUncached: number;
  inputCached: number;
  output: number;
  totalTokens: number;
};

type TokenStats = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  cost: number;
};

type TokenView = {
  current: TokenStats;
  aggs: {
    input: { mean: number; median: number };
    output: { mean: number; median: number };
    cacheCreation: { mean: number; median: number };
    cacheRead: { mean: number; median: number };
  };
  cacheRate: number;
};

function emptyTokenStats(): TokenStats {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0 };
}

function dayKey(d: Date): string {
  return d.toLocaleDateString("en-CA");
}
function weekKey(d: Date): string {
  const day = d.getDay() || 7;
  const monday = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() - day + 1,
  );
  return dayKey(monday);
}
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function mean(values: number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildDailyCost(rows: DailyByModelRow[]): {
  dailyCost: DailyCost[];
  models: string[];
} {
  const byDay = new Map<string, DailyCost>();
  const modelSet = new Set<string>();
  for (const r of rows) {
    modelSet.add(r.model);
    let d = byDay.get(r.day);
    if (!d) {
      d = {
        day: r.day,
        totalCost: 0,
        costByModel: {},
        inputUncached: 0,
        inputCached: 0,
        output: 0,
        totalTokens: 0,
      };
      byDay.set(r.day, d);
    }
    d.totalCost += r.cost;
    d.costByModel[r.model] = (d.costByModel[r.model] ?? 0) + r.cost;
    d.inputUncached += r.rawInput + r.cacheCreation;
    d.inputCached += r.cacheRead;
    d.output += r.output;
    d.totalTokens += r.rawInput + r.cacheCreation + r.cacheRead + r.output;
  }
  const dailyCost = [...byDay.values()].sort((a, b) =>
    a.day.localeCompare(b.day),
  );
  const models = [...modelSet].sort();
  return { dailyCost, models };
}

function buildTokenViews(rows: DailyByModelRow[]): {
  views: { day: TokenView; week: TokenView; month: TokenView };
  costSummary: { thisWeek: number; thisMonth: number };
} {
  const day = new Map<string, TokenStats>();
  const week = new Map<string, TokenStats>();
  const month = new Map<string, TokenStats>();
  const upsert = (
    m: Map<string, TokenStats>,
    k: string,
    r: DailyByModelRow,
  ) => {
    let b = m.get(k);
    if (!b) {
      b = emptyTokenStats();
      m.set(k, b);
    }
    b.input += r.rawInput + r.cacheCreation + r.cacheRead;
    b.output += r.output;
    b.cacheCreation += r.cacheCreation;
    b.cacheRead += r.cacheRead;
    b.cost += r.cost;
  };
  for (const r of rows) {
    const d = new Date(`${r.day}T00:00:00`);
    upsert(day, dayKey(d), r);
    upsert(week, weekKey(d), r);
    upsert(month, monthKey(d), r);
  }

  const nowDate = new Date();
  const todayK = dayKey(nowDate);
  const thisWeekK = weekKey(nowDate);
  const thisMonthK = monthKey(nowDate);

  const buildView = (
    m: Map<string, TokenStats>,
    currentKey: string,
  ): TokenView => {
    const current = m.get(currentKey) ?? emptyTokenStats();
    const all = [...m.values()];
    const aggs = (key: keyof TokenStats) => {
      const values = all.map((b) => b[key]);
      return { mean: mean(values), median: median(values) };
    };
    const cacheTotal = current.cacheCreation + current.cacheRead;
    return {
      current,
      aggs: {
        input: aggs("input"),
        output: aggs("output"),
        cacheCreation: aggs("cacheCreation"),
        cacheRead: aggs("cacheRead"),
      },
      cacheRate:
        cacheTotal > 0 ? Math.round((current.cacheRead / cacheTotal) * 100) : 0,
    };
  };

  return {
    views: {
      day: buildView(day, todayK),
      week: buildView(week, thisWeekK),
      month: buildView(month, thisMonthK),
    },
    costSummary: {
      thisWeek: week.get(thisWeekK)?.cost ?? 0,
      thisMonth: month.get(thisMonthK)?.cost ?? 0,
    },
  };
}

function buildActivityByDate(
  rows: DailyByModelRow[],
  sinceMs: number,
): Record<string, { count: number; cost: number }> {
  const out: Record<string, { count: number; cost: number }> = {};
  for (const r of rows) {
    const ts = new Date(`${r.day}T00:00:00`).getTime();
    if (ts < sinceMs) continue;
    if (!out[r.day]) out[r.day] = { count: 0, cost: 0 };
    out[r.day].count += r.turns;
    out[r.day].cost += r.cost;
  }
  return out;
}

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
