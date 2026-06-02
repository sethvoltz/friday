/**
 * Agent-status → status-dot color token (FRI-145 M5).
 *
 * The single source of truth for the colored dot next to an agent in the
 * Sidebar and the Command Palette. Both rendered the same mapping inline; M5
 * folds them into this one helper so the `stalled` branch — whose producer was
 * restored in M5 (the watchdog's `stall` Transition) — is unit-testable as
 * actual behavior, not a source-text match.
 *
 * Status namespace (post-M5 prune): `idle | working | stalled | archived`.
 * The agent-status `error` was pruned end-to-end in M5 — a worker that exits
 * mid-turn now self-heals to `idle`, so there is no resting `error` dot.
 *
 *   - working  → --status-ok   (active, green)
 *   - stalled  → --status-warn (no progress past the heartbeat budget, amber)
 *   - archived → --text-tertiary (muted; the caller usually hides the dot)
 *   - idle / unknown → --text-tertiary (muted)
 */
export function agentStatusDot(status: string | undefined): string {
  return status === "working"
    ? "var(--status-ok)"
    : status === "stalled"
      ? "var(--status-warn)"
      : "var(--text-tertiary)";
}
