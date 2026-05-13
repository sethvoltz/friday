import type { DailyByModelRow } from "@friday/shared/services";

export type DailyCost = {
  day: string;
  totalCost: number;
  costByModel: Record<string, number>;
  inputUncached: number;
  inputCached: number;
  output: number;
  totalTokens: number;
};

export type TokenStats = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  cost: number;
};

export type TokenView = {
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

function addRowInto(b: TokenStats, r: DailyByModelRow): void {
  b.input += r.rawInput + r.cacheCreation + r.cacheRead;
  b.output += r.output;
  b.cacheCreation += r.cacheCreation;
  b.cacheRead += r.cacheRead;
  b.cost += r.cost;
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

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildDailyCost(rows: DailyByModelRow[]): {
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

export function buildTokenViews(rows: DailyByModelRow[]): {
  views: { day: TokenView; week: TokenView; month: TokenView };
  costSummary: { thisWeek: number; thisMonth: number };
} {
  const dayBuckets = new Map<string, TokenStats>();
  const weekBuckets = new Map<string, TokenStats>();
  const monthBuckets = new Map<string, TokenStats>();
  const upsertHistorical = (
    m: Map<string, TokenStats>,
    k: string,
    r: DailyByModelRow,
  ) => {
    let b = m.get(k);
    if (!b) {
      b = emptyTokenStats();
      m.set(k, b);
    }
    addRowInto(b, r);
  };

  const nowDate = new Date();
  const nowMs = nowDate.getTime();
  const todayK = dayKey(nowDate);

  const dayCurrent = emptyTokenStats();
  const weekCurrent = emptyTokenStats();
  const monthCurrent = emptyTokenStats();

  for (const r of rows) {
    const d = new Date(`${r.day}T00:00:00`);
    upsertHistorical(dayBuckets, dayKey(d), r);
    upsertHistorical(weekBuckets, weekKey(d), r);
    upsertHistorical(monthBuckets, monthKey(d), r);

    if (dayKey(d) === todayK) addRowInto(dayCurrent, r);
    const ageMs = nowMs - d.getTime();
    if (ageMs >= 0 && ageMs < 7 * DAY_MS) addRowInto(weekCurrent, r);
    if (ageMs >= 0 && ageMs < 30 * DAY_MS) addRowInto(monthCurrent, r);
  }

  const buildView = (
    historical: Map<string, TokenStats>,
    current: TokenStats,
  ): TokenView => {
    const all = [...historical.values()];
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
      day: buildView(dayBuckets, dayCurrent),
      week: buildView(weekBuckets, weekCurrent),
      month: buildView(monthBuckets, monthCurrent),
    },
    costSummary: {
      thisWeek: weekCurrent.cost,
      thisMonth: monthCurrent.cost,
    },
  };
}

export function buildActivityByDate(
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
