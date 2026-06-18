/**
 * FRI-169 — Streak wiring (daemon boundary).
 *
 * The pure streak engine lives in `@friday/shared/habits` (computeStreak) and
 * imports nothing — every time input arrives via its `now` parameter. This
 * module is the daemon-side adapter: it projects a Drizzle `HabitRow` onto the
 * engine's storage-agnostic `HabitSpec`, projects `HabitCheckinRow[]` onto
 * `CheckinLike[]`, and INJECTS `now` HERE (the engine stays deterministic).
 *
 * `/api/habits` (list) and `/api/habits/<id>` (status) call into this so each
 * returned habit carries its live { state, count } and currentPeriodProgress.
 */

import { computeStreak } from "@friday/shared/habits";
import type {
  CheckinLike,
  HabitMode,
  HabitPeriod,
  HabitSpec,
  StreakResult,
} from "@friday/shared/habits";
import type { HabitCheckinRow, HabitRow } from "./store.js";

/**
 * Project a DB habit row onto the engine's HabitSpec. `mode`/`period` are
 * stored as text behind a check() constraint, so the cast to the closed union
 * is sound for any row that passed the DB write. timestamptz columns are
 * already `Date` (the pg driver decodes them); days_of_week passes through.
 */
export function rowToSpec(row: HabitRow): HabitSpec {
  return {
    mode: row.mode as HabitMode,
    period: row.period as HabitPeriod,
    target: row.target,
    daysOfWeek: row.daysOfWeek,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
  };
}

/** Project Check-in rows onto the engine's minimal CheckinLike[]. */
export function rowsToCheckins(rows: HabitCheckinRow[]): CheckinLike[] {
  return rows.map((r) => ({ ts: r.ts }));
}

/** The streak-decorated shape the routes return per habit. */
export interface HabitWithStreak extends HabitRow {
  streak: StreakResult;
  currentPeriodProgress: StreakResult["currentPeriodProgress"];
}

/**
 * Derive the live streak for one habit against `now` and merge it onto the
 * row. `now` is injected by the caller (the route) so the engine stays pure
 * and this function stays testable with a fixed clock.
 */
export function withStreak(row: HabitRow, checkins: HabitCheckinRow[], now: Date): HabitWithStreak {
  const streak = computeStreak(rowToSpec(row), rowsToCheckins(checkins), now);
  return { ...row, streak, currentPeriodProgress: streak.currentPeriodProgress };
}
