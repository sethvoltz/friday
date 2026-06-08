// Pure utility for ScheduleWakeupBlock — extracted so the node/forks vitest
// pool can unit-test it without a DOM or the Svelte plugin.

export function formatDelay(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  let h = Math.floor(seconds / 3600);
  let m = Math.round((seconds % 3600) / 60);
  if (m === 60) { h += 1; m = 0; }
  return `${h}h ${m}m`;
}
