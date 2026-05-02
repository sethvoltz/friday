import { defineCommand } from "citty";
import { getAllUsageEntries, type UsageEntryRow } from "@friday/shared";

interface PeriodStats {
  turns: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  durationMs: number;
}

function loadEntries(): UsageEntryRow[] {
  return getAllUsageEntries();
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function computeStats(entries: UsageEntryRow[]): PeriodStats {
  let cost = 0, inputTokens = 0, outputTokens = 0;
  let cacheCreationTokens = 0, cacheReadTokens = 0, durationMs = 0;

  for (const e of entries) {
    cost += e.costUsd ?? 0;
    inputTokens += e.inputTokens;
    outputTokens += e.outputTokens;
    cacheCreationTokens += e.cacheCreationTokens;
    cacheReadTokens += e.cacheReadTokens;
    durationMs += e.durationMs ?? 0;
  }

  return { turns: entries.length, cost, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, durationMs };
}

function cacheHitRate(stats: PeriodStats): string {
  const total = stats.cacheCreationTokens + stats.cacheReadTokens;
  if (total === 0) return "\u2014";
  return `${Math.round((stats.cacheReadTokens / total) * 100)}%`;
}

function printStats(label: string, stats: PeriodStats): void {
  if (stats.turns === 0) {
    console.log(`  ${label}: no activity`);
    return;
  }
  const avgCost = stats.turns > 0 ? formatCost(stats.cost / stats.turns) : "\u2014";
  console.log(`  ${label}: ${formatCost(stats.cost)} across ${stats.turns} turns (avg ${avgCost}/turn)`);
}

export const usageCommandCitty = defineCommand({
  meta: {
    name: "usage",
    description:
      "Show usage stats (cost, tokens, cache hit rate). Reads ~/.friday/usage.jsonl. Does not make any LLM calls.",
  },
  args: {
    verbose: {
      type: "boolean",
      alias: "v",
      description: "Show token breakdown",
      default: false,
    },
  },
  run({ args }) {
    usageCommand(args.verbose ? ["--verbose"] : []);
  },
});

export function usageCommand(args: string[]): void {
  const verbose = args.includes("--verbose") || args.includes("-v");

  const entries = loadEntries();
  if (entries.length === 0) {
    console.log("No usage data recorded yet.");
    return;
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;

  const todayEntries = entries.filter((e) => new Date(e.timestamp).getTime() >= todayStart);
  const weekEntries = entries.filter((e) => new Date(e.timestamp).getTime() >= weekStart);

  const allStats = computeStats(entries);
  const todayStats = computeStats(todayEntries);
  const weekStats = computeStats(weekEntries);

  console.log("\nFriday Usage Report");
  console.log("\u2550".repeat(40));

  printStats("Today    ", todayStats);
  printStats("This week", weekStats);
  printStats("All time ", allStats);

  console.log();
  console.log(`  Cache hit rate: ${cacheHitRate(allStats)}`);
  console.log(`  Total agent time: ${formatDuration(allStats.durationMs)}`);

  // Session breakdown
  const sessionMap = new Map<string, { type: string; turns: number; cost: number }>();
  for (const e of entries) {
    const existing = sessionMap.get(e.sessionId);
    if (existing) {
      existing.turns++;
      existing.cost += e.costUsd ?? 0;
    } else {
      sessionMap.set(e.sessionId, { type: e.sessionType, turns: 1, cost: e.costUsd ?? 0 });
    }
  }

  const orchestratorSessions = [...sessionMap.values()].filter((s) => s.type === "orchestrator");
  const independentSessions = [...sessionMap.values()].filter((s) => s.type === "independent");

  const orchTurns = orchestratorSessions.reduce((a, s) => a + s.turns, 0);
  const orchCost = orchestratorSessions.reduce((a, s) => a + s.cost, 0);
  const indTurns = independentSessions.reduce((a, s) => a + s.turns, 0);
  const indCost = independentSessions.reduce((a, s) => a + s.cost, 0);

  console.log();
  console.log(`  Orchestrator: ${orchTurns} turns, ${formatCost(orchCost)} (${orchestratorSessions.length} sessions)`);
  console.log(`  Independent:  ${indTurns} turns, ${formatCost(indCost)} (${independentSessions.length} sessions)`);

  if (verbose) {
    console.log();
    console.log("Token breakdown (all time):");
    console.log(`  Input:          ${allStats.inputTokens.toLocaleString()}`);
    console.log(`  Output:         ${allStats.outputTokens.toLocaleString()}`);
    console.log(`  Cache creation: ${allStats.cacheCreationTokens.toLocaleString()}`);
    console.log(`  Cache read:     ${allStats.cacheReadTokens.toLocaleString()}`);
  }

  console.log();
}
