// FRI-169 — Habit Zero-row → streak-engine adapter.
//
// THE ONE PLACE that bridges the snake_case, epoch-millis Zero mirror rows
// (`packages/shared/src/sync/schema.ts:habits` / `:habit_checkins`) to the
// pure, camelCase, Date-typed streak engine (`@friday/shared/habits`).
//
// THE TRAP this module exists to neutralise: the Zero row is snake_case
// (`days_of_week`, `window_start`) with epoch-millis NUMBER timestamps, but
// `computeStreak` / `resolveSlots` want a camelCase `HabitSpec` with `Date`
// objects and `CheckinLike { ts: Date }`. A wrong field name or an
// unconverted number silently yields a wrong/zero streak with no error.
// Every dashboard call site MUST route through `habitStreak` / `habitSlots`
// here — never hand-roll the projection at a component.

import {
  computeStreak,
  resolveSlots,
  type HabitSpec,
  type HabitPeriod,
  type StreakResult,
  type SlotResolution,
  type CheckinLike,
} from "@friday/shared/habits";

/**
 * The `habits` Zero-mirror row shape (snake_case, epoch-millis numbers).
 * Mirrors `packages/shared/src/sync/schema.ts:habits` exactly so the
 * dashboard's `zeroSync.habits` rows project onto these components without
 * a second mapping layer.
 */
export interface ZeroHabitRow {
  id: string;
  name: string;
  description?: string | null;
  mode: "ongoing" | "bounded";
  target: number;
  period: HabitPeriod;
  /** Weekday bitmask (Sun=bit0 … Sat=bit6); null/absent unless period='day'. */
  days_of_week?: number | null;
  bucket?: "morning" | "afternoon" | "evening" | "anytime" | null;
  /** Habit color slot 1..7; resolved to `var(--habit-N)` in the UI. */
  color_index?: number | null;
  /** Bounded-mode window bounds as epoch-millis. */
  window_start?: number | null;
  window_end?: number | null;
  status: "active" | "archived" | "completed" | "expired";
  created_at: number;
  updated_at: number;
}

/**
 * The `habit_checkins` Zero-mirror row shape (epoch-millis `ts`). Mirrors
 * `packages/shared/src/sync/schema.ts:habit_checkins`.
 */
export interface ZeroHabitCheckinRow {
  id: string;
  habit_id: string;
  /** Completion instant as epoch-millis. */
  ts: number;
  note?: string | null;
  created_at: number;
}

/**
 * Project a snake_case Zero habit row onto the camelCase `HabitSpec` the
 * streak engine consumes. Epoch-millis → `Date`; `days_of_week`/window
 * fields renamed and null-normalised. This is HALF the trap; the other
 * half (`ts: number → Date`) is `toCheckins` below.
 */
export function toHabitSpec(row: ZeroHabitRow): HabitSpec {
  return {
    mode: row.mode,
    period: row.period,
    target: row.target,
    daysOfWeek: row.days_of_week ?? null,
    windowStart: row.window_start != null ? new Date(row.window_start) : null,
    windowEnd: row.window_end != null ? new Date(row.window_end) : null,
  };
}

/**
 * Project epoch-millis Check-in rows onto the engine's `CheckinLike[]`
 * (each `ts` number → `Date`). The OTHER half of the trap.
 */
export function toCheckins(rows: ZeroHabitCheckinRow[]): CheckinLike[] {
  return rows.map((c) => ({ ts: new Date(c.ts) }));
}

/**
 * Compute the live Streak for a Zero habit row + its Check-in rows against
 * `now`. The single, centralised call site for `computeStreak` from the
 * dashboard — handles the snake_case → camelCase + epoch-millis → `Date`
 * mapping so no component does it by hand.
 */
export function habitStreak(
  row: ZeroHabitRow,
  checkinRows: ZeroHabitCheckinRow[],
  now: Date = new Date(),
): StreakResult {
  return computeStreak(toHabitSpec(row), toCheckins(checkinRows), now);
}

/**
 * Resolve the per-Slot square states for the Period containing `periodRef`,
 * deciding open-vs-closed against `now`. Centralised mapping, same as
 * `habitStreak`. `periodRef` selects WHICH Period (any instant inside it).
 */
export function habitSlots(
  row: ZeroHabitRow,
  checkinRows: ZeroHabitCheckinRow[],
  periodRef: Date,
  now: Date = new Date(),
): SlotResolution {
  return resolveSlots(toHabitSpec(row), toCheckins(checkinRows), periodRef, now);
}

/**
 * Streak headline unit label for a Period — "day streak", "week streak",
 * etc. Used by the summary row's `[N <unit> streak]` headline.
 */
export function streakUnitLabel(period: HabitPeriod): string {
  switch (period) {
    case "day":
      return "day streak";
    case "week":
      return "week streak";
    case "month":
      return "month streak";
    case "year":
      return "year streak";
  }
}

/**
 * Is `row` expected to be checked off on the calendar day containing `now`?
 * Drives the Today card's "today's expected habits" list.
 *
 * A habit is expected today iff:
 *   - it is `active` (archived/completed/expired never appear), AND
 *   - for a weekday-constrained day-Period habit (`period='day'` with a
 *     `days_of_week` mask), today's weekday is one of the listed days;
 *     unmasked day-habits and all week/month/year habits are expected every
 *     day they have an open Period, AND
 *   - for a Bounded habit, `now` is within [windowStart, windowEnd).
 *
 * Time-of-day bucket is NOT a determinant — it only groups the list (a
 * `morning` habit is still "expected today", just rendered under Morning).
 */
export function isExpectedToday(row: ZeroHabitRow, now: Date = new Date()): boolean {
  if (row.status !== "active") return false;

  // Bounded-window gating: only expected while the window is open.
  if (row.mode === "bounded") {
    const t = now.getTime();
    if (row.window_start != null && t < row.window_start) return false;
    if (row.window_end != null && t >= row.window_end) return false;
  }

  // Weekday-constrained day-Period habits are expected only on listed days.
  if (row.period === "day" && row.days_of_week != null) {
    return (row.days_of_week & (1 << now.getDay())) !== 0;
  }

  // Unmasked day habits + all week/month/year habits are expected every day
  // they have an open Period (which, for an active habit, is today).
  return true;
}

/**
 * Time-of-day bucket key for grouping the Today card. A null/absent bucket
 * groups under "anytime" (the glossary default).
 */
export function bucketKey(row: ZeroHabitRow): "morning" | "afternoon" | "evening" | "anytime" {
  return row.bucket ?? "anytime";
}
