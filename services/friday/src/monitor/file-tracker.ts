/**
 * Turn-scoped file-touch tracking.
 *
 * Maintains a per-agent sliding window of files accessed (Read/Write/Edit)
 * in each turn. The window is capped at FILE_WINDOW_SIZE turns; the oldest
 * entry falls off when a new turn is pushed.
 *
 * The window is in-memory only — it is not persisted across daemon restarts.
 * On agent destroy, the window is cleared immediately.
 */

export const FILE_WINDOW_SIZE = 10;

export interface TurnFileEntry {
  turn: number;
  files: string[];
}

/** Per-agent sliding window: [oldest ... newest] */
const windows = new Map<string, TurnFileEntry[]>();

/**
 * Record files accessed in a given turn for an agent.
 * Slides the window, dropping the oldest entry if already at capacity.
 */
export function recordTurnFiles(
  agentName: string,
  turn: number,
  files: string[]
): void {
  let window = windows.get(agentName);
  if (!window) {
    window = [];
    windows.set(agentName, window);
  }

  window.push({ turn, files });

  if (window.length > FILE_WINDOW_SIZE) {
    window.shift();
  }
}

/**
 * Return the sliding window for an agent, optionally limited to the last N turns.
 * Returns entries ordered oldest-first (same as insertion order).
 */
export function getRecentlyTouchedFiles(
  agentName: string,
  turnsBack?: number
): TurnFileEntry[] {
  const window = windows.get(agentName) ?? [];
  if (turnsBack === undefined || turnsBack >= window.length) {
    return [...window];
  }
  return window.slice(-turnsBack);
}

/**
 * Clear all file-tracking state for an agent.
 * Called on agent destroy and on kill.
 */
export function clearFileTracking(agentName: string): void {
  windows.delete(agentName);
}

/** @internal — for test isolation only */
export function _resetAllTracking(): void {
  windows.clear();
}
