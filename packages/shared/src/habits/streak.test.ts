// FRI-169 AC9–AC13 — Habit streak engine unit tests (pure, no PG).
//
// Every Date is built from explicit LOCAL-time components
// (new Date(year, monthIdx, day, hour, min)) so the suite is independent
// of the runner's timezone — the engine computes Period boundaries with
// the same local getters, so a local-component instant lands in the
// expected Period in any TZ frame.

import { describe, expect, it } from "vitest";
import { computeStreak, resolveSlots, type CheckinLike, type HabitSpec } from "./streak.js";

/** Build a Check-in at a local-time instant. */
function ci(y: number, mIdx: number, d: number, h = 12, min = 0): CheckinLike {
  return { ts: new Date(y, mIdx, d, h, min) };
}

const dayHabit: HabitSpec = { mode: "ongoing", period: "day", target: 1 };
const monthHabit: HabitSpec = { mode: "ongoing", period: "month", target: 5 };

describe("FRI-169 computeStreak — day-Period target=1 (AC9)", () => {
  it("(a) dormant on an empty log", () => {
    const now = new Date(2026, 5, 18, 8, 0); // 2026-06-18T08:00 local
    const r = computeStreak(dayHabit, [], now);
    expect(r.state).toBe("dormant");
    expect(r.count).toBe(0);
    expect(r.currentPeriodProgress).toEqual({ filled: 0, target: 1 });
  });

  it("(b) active_pending count 3 — 3 prior days, none today", () => {
    // now = 2026-06-18T08:00; check-ins on Jun 15, 16, 17 (the 3 days
    // immediately before today), nothing today.
    const now = new Date(2026, 5, 18, 8, 0);
    const checkins = [ci(2026, 5, 15), ci(2026, 5, 16), ci(2026, 5, 17)];
    const r = computeStreak(dayHabit, checkins, now);
    expect(r.state).toBe("active_pending");
    expect(r.count).toBe(3);
    expect(r.currentPeriodProgress).toEqual({ filled: 0, target: 1 });
  });

  it("(c) active_satisfied count 4 — same plus one today", () => {
    const now = new Date(2026, 5, 18, 8, 0);
    const checkins = [
      ci(2026, 5, 15),
      ci(2026, 5, 16),
      ci(2026, 5, 17),
      ci(2026, 5, 18, 7, 30), // today, before `now`
    ];
    const r = computeStreak(dayHabit, checkins, now);
    expect(r.state).toBe("active_satisfied");
    expect(r.count).toBe(4);
    expect(r.currentPeriodProgress).toEqual({ filled: 1, target: 1 });
  });
});

describe("FRI-169 computeStreak — clock-boundary break (AC10)", () => {
  // Identical check-ins through 2026-06-15, nothing after. Two `now`s.
  const checkins = [ci(2026, 5, 13), ci(2026, 5, 14), ci(2026, 5, 15)];

  it("active_pending while the next day is still open (now = Jun-16 08:00)", () => {
    const now = new Date(2026, 5, 16, 8, 0);
    const r = computeStreak(dayHabit, checkins, now);
    expect(r.state).toBe("active_pending");
    expect(r.count).toBe(3);
  });

  it("dormant once the unsatisfied Jun-16 day has CLOSED (now = Jun-17 00:01)", () => {
    const now = new Date(2026, 5, 17, 0, 1);
    const r = computeStreak(dayHabit, checkins, now);
    // Jun-16 closed with no Check-in → the run broke on the clock alone.
    expect(r.state).toBe("dormant");
    expect(r.count).toBe(0);
  });
});

describe("FRI-169 computeStreak — immediate tick on satisfy (AC11)", () => {
  it("ticks N → N+1 at the SAME now when today's target-th check-in is appended", () => {
    const now = new Date(2026, 5, 18, 9, 0);
    const prior = [ci(2026, 5, 15), ci(2026, 5, 16), ci(2026, 5, 17)];

    const before = computeStreak(dayHabit, prior, now);
    expect(before.state).toBe("active_pending");
    expect(before.count).toBe(3);

    const after = computeStreak(dayHabit, [...prior, ci(2026, 5, 18, 8, 0)], now);
    expect(after.state).toBe("active_satisfied");
    expect(after.count).toBe(4);
  });
});

describe("FRI-169 computeStreak — month-Period target=5 (AC12)", () => {
  // now in June 2026.
  const now = new Date(2026, 5, 18, 8, 0);

  it("(a) dormant on an empty log", () => {
    const r = computeStreak(monthHabit, [], now);
    expect(r.state).toBe("dormant");
    expect(r.count).toBe(0);
    expect(r.currentPeriodProgress).toEqual({ filled: 0, target: 5 });
  });

  it("(b) active_pending count 2 — 5 in Apr, 5 in May, 4 so far in Jun", () => {
    const checkins = [
      // April (5)
      ci(2026, 3, 2),
      ci(2026, 3, 9),
      ci(2026, 3, 16),
      ci(2026, 3, 23),
      ci(2026, 3, 30),
      // May (5)
      ci(2026, 4, 3),
      ci(2026, 4, 10),
      ci(2026, 4, 17),
      ci(2026, 4, 24),
      ci(2026, 4, 31),
      // June so far (4)
      ci(2026, 5, 4),
      ci(2026, 5, 9),
      ci(2026, 5, 14),
      ci(2026, 5, 17),
    ];
    const r = computeStreak(monthHabit, checkins, now);
    expect(r.state).toBe("active_pending");
    expect(r.count).toBe(2);
    expect(r.currentPeriodProgress).toEqual({ filled: 4, target: 5 });
  });

  it("(c) active_satisfied count 3 — the 5th June check-in at the same now", () => {
    const checkins = [
      ci(2026, 3, 2),
      ci(2026, 3, 9),
      ci(2026, 3, 16),
      ci(2026, 3, 23),
      ci(2026, 3, 30),
      ci(2026, 4, 3),
      ci(2026, 4, 10),
      ci(2026, 4, 17),
      ci(2026, 4, 24),
      ci(2026, 4, 31),
      ci(2026, 5, 4),
      ci(2026, 5, 9),
      ci(2026, 5, 14),
      ci(2026, 5, 17),
      ci(2026, 5, 18, 7, 0), // the 5th, before `now`
    ];
    const r = computeStreak(monthHabit, checkins, now);
    expect(r.state).toBe("active_satisfied");
    expect(r.count).toBe(3);
    expect(r.currentPeriodProgress).toEqual({ filled: 5, target: 5 });
  });

  it("(break) an empty CLOSED month between runs → dormant", () => {
    // Apr satisfied (5), May EMPTY (0, closed), June 4 so far. The empty
    // closed May breaks the run; the open June (sub-target) can't carry.
    const checkins = [
      ci(2026, 3, 2),
      ci(2026, 3, 9),
      ci(2026, 3, 16),
      ci(2026, 3, 23),
      ci(2026, 3, 30),
      ci(2026, 5, 4),
      ci(2026, 5, 9),
      ci(2026, 5, 14),
      ci(2026, 5, 17),
    ];
    const r = computeStreak(monthHabit, checkins, now);
    expect(r.state).toBe("dormant");
    expect(r.count).toBe(0);
    expect(r.currentPeriodProgress).toEqual({ filled: 4, target: 5 });
  });
});

describe("FRI-169 resolveSlots — per-day-slash vs floating-quota-slash (AC13)", () => {
  const perDay: HabitSpec = { mode: "ongoing", period: "day", target: 3 };
  const floatingWeek: HabitSpec = { mode: "ongoing", period: "week", target: 4 };

  it("per-day OPEN today: unfilled Slots read 'empty'", () => {
    const ref = new Date(2026, 5, 18, 10, 0);
    const now = new Date(2026, 5, 18, 10, 0); // same day, open
    const checkins = [ci(2026, 5, 18, 8), ci(2026, 5, 18, 9)]; // 2 of 3
    const r = resolveSlots(perDay, checkins, ref, now);
    expect(r.open).toBe(true);
    expect(r.slots).toEqual(["filled", "filled", "empty"]);
    expect(r.overflow).toBe(0);
  });

  it("per-day CLOSED past day: unfilled Slots read 'slashed' (a miss)", () => {
    const ref = new Date(2026, 5, 15, 10, 0); // 3 days ago
    const now = new Date(2026, 5, 18, 10, 0); // well past that day's close
    const checkins = [ci(2026, 5, 15, 8)]; // 1 of 3 that day
    const r = resolveSlots(perDay, checkins, ref, now);
    expect(r.open).toBe(false);
    expect(r.slots).toEqual(["filled", "slashed", "slashed"]);
    expect(r.overflow).toBe(0);
  });

  it("floating-quota OPEN week: unfilled Slots stay 'empty' while the Period is open", () => {
    // Week of Jun 14 (Sun) – Jun 20 (Sat). ref + now both inside it.
    const ref = new Date(2026, 5, 16, 12, 0);
    const now = new Date(2026, 5, 17, 12, 0);
    const checkins = [ci(2026, 5, 14, 9), ci(2026, 5, 16, 9)]; // 2 of 4
    const r = resolveSlots(floatingWeek, checkins, ref, now);
    expect(r.open).toBe(true);
    expect(r.slots).toEqual(["filled", "filled", "empty", "empty"]);
    expect(r.overflow).toBe(0);
  });

  it("floating-quota CLOSED week: unfilled remainder slashes only at Period close", () => {
    // Resolve the PRIOR week (Jun 7–13) from a now past its close.
    const ref = new Date(2026, 5, 10, 12, 0);
    const now = new Date(2026, 5, 18, 12, 0); // past Jun-13 week close
    const checkins = [ci(2026, 5, 8, 9), ci(2026, 5, 11, 9)]; // 2 of 4
    const r = resolveSlots(floatingWeek, checkins, ref, now);
    expect(r.open).toBe(false);
    expect(r.slots).toEqual(["filled", "filled", "slashed", "slashed"]);
    expect(r.overflow).toBe(0);
  });

  it("overflow: Check-ins past Target count as volume, not extra Slots", () => {
    const ref = new Date(2026, 5, 18, 12, 0);
    const now = new Date(2026, 5, 18, 13, 0);
    const checkins = [
      ci(2026, 5, 18, 8),
      ci(2026, 5, 18, 9),
      ci(2026, 5, 18, 10),
      ci(2026, 5, 18, 11),
    ];
    const r = resolveSlots(perDay, checkins, ref, now); // target 3, 4 check-ins
    expect(r.slots).toEqual(["filled", "filled", "filled"]);
    expect(r.overflow).toBe(1);
  });
});

describe("FRI-169 computeStreak — weekday-constrained day-Period (MWF)", () => {
  // Mon=bit1, Wed=bit3, Fri=bit5 → 0b101010 = 42.
  const mwf: HabitSpec = { mode: "ongoing", period: "day", target: 1, daysOfWeek: 0b101010 };

  it("Tue/Thu gaps do NOT break the run — only listed weekdays count", () => {
    // June 2026: Mon 1, Wed 3, Fri 5, Mon 8, Wed 10, Fri 12 are listed.
    // now = Sat Jun 13 08:00 (open, but Sat is not listed → carries the
    // run forward from the last listed day).
    const checkins = [
      ci(2026, 5, 1),
      ci(2026, 5, 3),
      ci(2026, 5, 5),
      ci(2026, 5, 8),
      ci(2026, 5, 10),
      ci(2026, 5, 12),
    ];
    const now = new Date(2026, 5, 13, 8, 0);
    const r = computeStreak(mwf, checkins, now);
    // 6 listed days satisfied; the open Sat isn't a counted Period, so the
    // run is the 6 prior listed days, held pending.
    expect(r.count).toBe(6);
    expect(["active_pending", "active_satisfied"]).toContain(r.state);
  });

  it("a missed listed Wednesday breaks the run at its close", () => {
    // Only Mon Jun 1 checked. now = Fri Jun 5 08:00 — Wed Jun 3 (a listed
    // day) closed with no check-in, breaking the run before today.
    const checkins = [ci(2026, 5, 1)];
    const now = new Date(2026, 5, 5, 8, 0);
    const r = computeStreak(mwf, checkins, now);
    expect(r.state).toBe("dormant");
    expect(r.count).toBe(0);
  });
});

describe("FRI-169 computeStreak — Bounded mode window close", () => {
  const windowStart = new Date(2026, 5, 1, 0, 0);
  const windowEnd = new Date(2026, 5, 6, 0, 0); // exclusive close at Jun-6 00:00
  const bounded: HabitSpec = {
    mode: "bounded",
    period: "day",
    target: 1,
    windowStart,
    windowEnd,
  };

  it("completed: a live run at window close → terminal 'completed', state dormant", () => {
    // Check-ins each day Jun 1–5; now past the window close.
    const checkins = [
      ci(2026, 5, 1),
      ci(2026, 5, 2),
      ci(2026, 5, 3),
      ci(2026, 5, 4),
      ci(2026, 5, 5),
    ];
    const now = new Date(2026, 5, 10, 8, 0);
    const r = computeStreak(bounded, checkins, now);
    expect(r.terminal).toBe("completed");
    expect(r.state).toBe("dormant");
    expect(r.count).toBe(5);
  });

  it("expired: no live run at window close → terminal 'expired'", () => {
    // The last in-window day (Jun 5) is empty and earlier days don't reach
    // the close, so the run at close is 0.
    const checkins = [ci(2026, 5, 1)];
    const now = new Date(2026, 5, 10, 8, 0);
    const r = computeStreak(bounded, checkins, now);
    expect(r.terminal).toBe("expired");
    expect(r.state).toBe("dormant");
    expect(r.count).toBe(0);
  });

  it("in-window: no terminal decoration before the window closes", () => {
    const checkins = [ci(2026, 5, 1), ci(2026, 5, 2)];
    const now = new Date(2026, 5, 3, 8, 0); // still inside the window
    const r = computeStreak(bounded, checkins, now);
    expect(r.terminal).toBeUndefined();
    expect(r.state).toBe("active_pending");
    expect(r.count).toBe(2);
  });
});
