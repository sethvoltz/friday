import { readFileSync, existsSync } from "node:fs";
import type { UsageEntry } from "@friday/shared";
import { USAGE_LOG_PATH } from "@friday/shared";

export interface SessionStats {
  sessionId: string;
  turnCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  cacheHitRate: number; // 0-100
  firstTurnAt: string;
  lastTurnAt: string;
  totalDurationMs: number;
}

export function getSessionStats(sessionId: string): SessionStats | null {
  if (!existsSync(USAGE_LOG_PATH)) return null;

  const lines = readFileSync(USAGE_LOG_PATH, "utf-8")
    .split("\n")
    .filter((l) => l.trim());

  const entries: UsageEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as UsageEntry;
      if (entry.sessionId === sessionId) {
        entries.push(entry);
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (entries.length === 0) return null;

  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  let totalDuration = 0;

  for (const e of entries) {
    totalCost += e.costUsd ?? 0;
    totalInput += e.inputTokens;
    totalOutput += e.outputTokens;
    totalCacheCreation += e.cacheCreationTokens;
    totalCacheRead += e.cacheReadTokens;
    totalDuration += e.durationMs;
  }

  const totalCacheTokens = totalCacheCreation + totalCacheRead;
  const cacheHitRate =
    totalCacheTokens > 0
      ? Math.round((totalCacheRead / totalCacheTokens) * 100)
      : 0;

  return {
    sessionId,
    turnCount: entries.length,
    totalCostUsd: totalCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheCreationTokens: totalCacheCreation,
    totalCacheReadTokens: totalCacheRead,
    cacheHitRate,
    firstTurnAt: entries[0].timestamp,
    lastTurnAt: entries[entries.length - 1].timestamp,
    totalDurationMs: totalDuration,
  };
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

export function formatAge(isoTimestamp: string): string {
  const then = new Date(isoTimestamp).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
