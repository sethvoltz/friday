// FRI-169 — Habit streak engine (pure, browser-safe, dependency-free).
//
// A Streak is the run of consecutive Satisfied periods for a Habit,
// counted in the Habit's Period unit, DERIVED ON READ from the Check-in
// log against the current clock — never stored (see CONTEXT.md ### Habits
// and the `habits` table comment in db/schema.ts). This module is the
// single source of that derivation, consumed by BOTH the daemon
// (`habit_list` / `habit_status` MCP tools) and the browser (the
// dashboard Today card + /habits route). It therefore imports NOTHING —
// no daemon modules, no node built-ins, no `Date.now()` in code — every
// time input arrives via the `now` parameter so the function is
// deterministic and unit-testable.
//
// Period boundaries are computed in LOCAL time using native `Date`
// getters (the same frame the user reads the calendar in). Weeks are
// Sunday-anchored. days_of_week is a weekday bitmask Sun=bit0 … Sat=bit6.

/** The closed enum unions, mirrored from the `habits` table check()s. */
export type HabitPeriod = "day" | "week" | "month" | "year";
export type HabitMode = "ongoing" | "bounded";

/**
 * Minimal habit shape the streak engine needs. NOT the Drizzle row type —
 * callers project their row (DB or Zero-mirror) onto this so the engine
 * stays storage-agnostic and browser-safe.
 */
export interface HabitSpec {
  mode: HabitMode;
  period: HabitPeriod;
  /** Check-ins required within one Period to satisfy it (>= 1). */
  target: number;
  /**
   * Weekday bitmask (Sun=bit0 … Sat=bit6), only meaningful for
   * period='day'. When set, only the listed weekdays are Periods that can
   * satisfy or break the Streak; non-listed days are skipped entirely.
   */
  daysOfWeek?: number | null;
  /** Bounded-mode window. Ignored for Ongoing habits. */
  windowStart?: Date | null;
  windowEnd?: Date | null;
}

/** A single Check-in — only its completion time matters for the Streak. */
export interface CheckinLike {
  ts: Date;
}

export type StreakState = "dormant" | "active_pending" | "active_satisfied";

/** Bounded-mode terminal decoration once `now >= windowEnd`. */
export type StreakTerminal = "completed" | "expired";

export interface StreakResult {
  state: StreakState;
  /** Consecutive Satisfied periods, counted in the Period unit. */
  count: number;
  /** Progress within the current (open) Period. */
  currentPeriodProgress: { filled: number; target: number };
  /** Present only for Bounded habits whose window has closed. */
  terminal?: StreakTerminal;
}

/** Square states for the per-Slot UI (see CONTEXT.md ### Habits → Slot). */
export type SlotState = "empty" | "slashed" | "filled";

export interface SlotResolution {
  /** One entry per Target Slot, filled in order by Check-ins. */
  slots: SlotState[];
  /** Check-ins past Target within the Period (volume, rendered `+k`). */
  overflow: number;
  /** Whether the referenced Period is still open at `now`. */
  open: boolean;
}

// ----------------------------------------------------------------------
// Period boundary helpers (local time).
//
// Each returns the [start, end) half-open interval for the Period that
// CONTAINS the given instant. `end` is the exclusive close — the Period is
// open at `now` iff start <= now < end.
// ----------------------------------------------------------------------

function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function weekStart(d: Date): Date {
  const s = dayStart(d);
  // Sunday-anchored: subtract the local weekday index (Sun=0).
  s.setDate(s.getDate() - s.getDay());
  return s;
}

function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function yearStart(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1);
}

/** Start of the Period (of the habit's `period` unit) containing `d`. */
function periodStart(period: HabitPeriod, d: Date): Date {
  switch (period) {
    case "day":
      return dayStart(d);
    case "week":
      return weekStart(d);
    case "month":
      return monthStart(d);
    case "year":
      return yearStart(d);
  }
}

/** Start of the Period immediately AFTER the one containing `d`. */
function nextPeriodStart(period: HabitPeriod, d: Date): Date {
  const s = periodStart(period, d);
  switch (period) {
    case "day":
      return new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1);
    case "week":
      return new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7);
    case "month":
      return new Date(s.getFullYear(), s.getMonth() + 1, 1);
    case "year":
      return new Date(s.getFullYear() + 1, 0, 1);
  }
}

/** Start of the Period immediately BEFORE the one containing `d`. */
function prevPeriodStart(period: HabitPeriod, d: Date): Date {
  const s = periodStart(period, d);
  switch (period) {
    case "day":
      return new Date(s.getFullYear(), s.getMonth(), s.getDate() - 1);
    case "week":
      return new Date(s.getFullYear(), s.getMonth(), s.getDate() - 7);
    case "month":
      return new Date(s.getFullYear(), s.getMonth() - 1, 1);
    case "year":
      return new Date(s.getFullYear() - 1, 0, 1);
  }
}

/**
 * For a weekday-constrained day-Period habit, is this day-start one of the
 * listed weekdays? Non-day periods and unmasked habits count every Period.
 */
function isCountedPeriod(habit: HabitSpec, pStart: Date): boolean {
  if (habit.period !== "day") return true;
  const mask = habit.daysOfWeek;
  if (mask == null) return true;
  return (mask & (1 << pStart.getDay())) !== 0;
}

/**
 * Walk to the previous COUNTED Period start (skipping non-listed weekdays
 * for masked day-habits). For non-day / unmasked habits this is just the
 * immediately-previous Period.
 */
function prevCountedPeriodStart(habit: HabitSpec, pStart: Date): Date {
  let s = prevPeriodStart(habit.period, pStart);
  // Bounded loop: at most 7 hops to find the previous listed weekday.
  for (let i = 0; i < 8 && !isCountedPeriod(habit, s); i++) {
    s = prevPeriodStart(habit.period, s);
  }
  return s;
}

// ----------------------------------------------------------------------
// Check-in tallying.
// ----------------------------------------------------------------------

/** Count Check-ins whose `ts` falls in [start, end). */
function countInRange(checkins: CheckinLike[], start: Date, end: Date): number {
  const lo = start.getTime();
  const hi = end.getTime();
  let n = 0;
  for (const c of checkins) {
    const t = c.ts.getTime();
    if (t >= lo && t < hi) n++;
  }
  return n;
}

function isSatisfied(habit: HabitSpec, checkins: CheckinLike[], pStart: Date): boolean {
  const pEnd = nextPeriodStart(habit.period, pStart);
  return countInRange(checkins, pStart, pEnd) >= Math.max(1, habit.target);
}

/** Earliest Check-in instant, or +Infinity when the log is empty. */
function earliestTs(checkins: CheckinLike[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const c of checkins) {
    const t = c.ts.getTime();
    if (t < min) min = t;
  }
  return min;
}

/**
 * Walk consecutive Satisfied counted-Periods strictly before `openStart`
 * and return the run length. The walk stops at the first unsatisfied
 * counted Period (the clock-boundary break) or once it passes the earliest
 * Check-in (no earlier Period can be satisfied).
 */
function priorRunLength(habit: HabitSpec, checkins: CheckinLike[], openStart: Date): number {
  let run = 0;
  let cursor = prevCountedPeriodStart(habit, openStart);
  const earliest = earliestTs(checkins);
  // Stop once the cursor's Period lies entirely before the earliest
  // Check-in (no earlier Period can be Satisfied). A Period can hold a
  // Check-in iff its exclusive end is strictly after `earliest` — compare
  // the Period END, not its start (a midnight start can precede a noon
  // Check-in within the same day).
  while (
    nextPeriodStart(habit.period, cursor).getTime() > earliest &&
    isSatisfied(habit, checkins, cursor)
  ) {
    run++;
    cursor = prevCountedPeriodStart(habit, cursor);
  }
  return run;
}

// ----------------------------------------------------------------------
// computeStreak — the core derivation.
// ----------------------------------------------------------------------

/**
 * Derive the Streak for `habit` from its `checkins` against `now`.
 *
 * Algorithm (counts consecutive Satisfied periods, in the Period unit):
 *   1. Take the current (open) Period containing `now`. Its filled count
 *      is `currentPeriodProgress`.
 *   2. Walk strictly backward over counted Periods while each is
 *      Satisfied — that run is `priorRun`.
 *   3. If the open Period is itself Satisfied → it ticks the run to N+1
 *      immediately (state `active_satisfied`). Else if a live run sits
 *      behind it → state `active_pending`, count = priorRun. Else dormant.
 *
 * The break is purely a clock event: an unsatisfied Period that has CLOSED
 * (is strictly before the open Period) ends the run — no Check-in is
 * needed to break it. Re-computing at a later `now` that crossed a Period
 * close with no new Check-in drops the count to 0 (dormant).
 *
 * Bounded mode: once `now >= windowEnd`, the result is decorated with
 * `terminal` — `completed` if the run at window-close was live (> 0), else
 * `expired` — and the live state collapses to dormant.
 */
export function computeStreak(habit: HabitSpec, checkins: CheckinLike[], now: Date): StreakResult {
  const target = Math.max(1, habit.target);

  const openStart = periodStart(habit.period, now);
  const openEnd = nextPeriodStart(habit.period, openStart);
  const openFilled = countInRange(checkins, openStart, openEnd);
  const currentPeriodProgress = { filled: openFilled, target };
  const openSatisfied = openFilled >= target;

  const priorRun = priorRunLength(habit, checkins, openStart);

  let count: number;
  let state: StreakState;
  if (openSatisfied) {
    count = priorRun + 1;
    state = "active_satisfied";
  } else if (priorRun > 0) {
    count = priorRun;
    state = "active_pending";
  } else {
    count = 0;
    state = "dormant";
  }

  const result: StreakResult = { state, count, currentPeriodProgress };

  // Bounded-mode terminal decoration: snapshot the run as of the window
  // close so a post-window `now` doesn't artificially break it.
  if (habit.mode === "bounded" && habit.windowEnd && now.getTime() >= habit.windowEnd.getTime()) {
    const closeRef = new Date(habit.windowEnd.getTime() - 1);
    const closeOpenStart = periodStart(habit.period, closeRef);
    const closeOpenEnd = nextPeriodStart(habit.period, closeOpenStart);
    const closeFilled = countInRange(checkins, closeOpenStart, closeOpenEnd);
    const closePriorRun = priorRunLength(habit, checkins, closeOpenStart);
    const closeCount = closeFilled >= target ? closePriorRun + 1 : closePriorRun;

    result.count = closeCount;
    result.currentPeriodProgress = { filled: closeFilled, target };
    result.terminal = closeCount > 0 ? "completed" : "expired";
    result.state = "dormant";
  }

  return result;
}

// ----------------------------------------------------------------------
// resolveSlots — per-Period Slot square resolution.
//
// One Slot per Target. Slots fill in order by Check-in. The single
// open/closed rule subsumes BOTH families (CONTEXT.md ### Habits → Slot):
//   - Per-day habit (period='day'): the Period is the day; it closes at
//     day-end, so an unfilled Slot in a past day reads 'slashed'.
//   - Floating-quota habit (period=week|month|year): the Period closes at
//     Period-end; unfilled Slots read 'empty' while open, 'slashed' once
//     the Period has closed.
//
// `periodRef` selects WHICH Period to resolve (any instant inside it);
// `now` decides open-vs-closed. Check-ins past Target are `overflow`.
// ----------------------------------------------------------------------

export function resolveSlots(
  habit: HabitSpec,
  checkins: CheckinLike[],
  periodRef: Date,
  now: Date,
): SlotResolution {
  const target = Math.max(1, habit.target);
  const pStart = periodStart(habit.period, periodRef);
  const pEnd = nextPeriodStart(habit.period, pStart);

  const filledCount = countInRange(checkins, pStart, pEnd);
  // Open iff `now` is strictly before the Period's exclusive close.
  const open = now.getTime() < pEnd.getTime();

  const slots: SlotState[] = [];
  for (let i = 0; i < target; i++) {
    if (i < filledCount) {
      slots.push("filled");
    } else {
      // Unfilled: empty while the Period is still open (not yet missed),
      // slashed once the Period has closed (an expected-but-missed Slot).
      slots.push(open ? "empty" : "slashed");
    }
  }

  const overflow = Math.max(0, filledCount - target);
  return { slots, overflow, open };
}
