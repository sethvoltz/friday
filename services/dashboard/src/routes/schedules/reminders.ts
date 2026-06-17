/**
 * Pure-logic helpers for the reminders surface on /schedules (FRI-168).
 *
 * Kept DOM-free and deterministic so they can be unit-tested without a
 * browser, Zero, or the page component (AC11 lives at this layer). The
 * page wires these to the existing Zero-backed `schedules` array.
 */

/** A `schedules` row's `kind` is "reminder" rather than the default "agent-run". */
export function isReminder(row: { kind: string }): boolean {
  return row.kind === "reminder";
}

/** Keep only reminder rows, dropping agent-run schedules. */
export function filterReminders<T extends { kind: string }>(rows: T[]): T[] {
  return rows.filter(isReminder);
}

/**
 * The "Upcoming reminders" agenda shows the next 7 days. A week is short
 * enough to stay a glanceable agenda (not an exhaustive list) yet long
 * enough to cover the common "remind me next <weekday>" case.
 */
export const UPCOMING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Reminders firing within `[now, now + windowMs]`, soonest first. Rows
 * with a null `nextRunAt` (no scheduled next run) are excluded, as are
 * agent-run rows.
 */
export function upcomingReminders<T extends { kind: string; nextRunAt: number | null }>(
  rows: T[],
  now: number,
  windowMs = UPCOMING_WINDOW_MS,
): T[] {
  return filterReminders(rows)
    .filter((r) => r.nextRunAt !== null && r.nextRunAt >= now && r.nextRunAt <= now + windowMs)
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
}
