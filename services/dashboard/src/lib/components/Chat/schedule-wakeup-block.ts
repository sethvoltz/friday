// Pure utility for ScheduleWakeupBlock — extracted so the node/forks vitest
// pool can unit-test it without a DOM or the Svelte plugin.

/**
 * Human-readable delay string from a raw second count.
 *  < 60 s  → "Xs"       e.g. "30s"
 *  < 1 h   → "Xm"       e.g. "5m"  (rounded minutes)
 *  ≥ 1 h   → "Xh Ym"   e.g. "1h 20m"
 */
export function formatDelay(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
