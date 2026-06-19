// FRI-169 — unit proof that the snake_case / epoch-millis Zero row → the
// camelCase / Date-typed streak engine mapping is correct (THE TRAP).
//
// These tests deliberately feed the engine through `habitStreak` /
// `habitSlots` using SNAKE_CASE rows with NUMBER timestamps — exactly what
// `zeroSync.habits` / `zeroSync.habitCheckins` deliver — and pin the exact
// {state,count} / slot-state arrays from the ticket's AC9 / AC12 / AC13.
// A wrong field name (e.g. reading `row.daysOfWeek` off a snake_case row)
// or an unconverted epoch-millis number would silently yield a wrong/zero
// streak; these assertions would catch it.

import { describe, it, expect } from "vitest";
import {
  habitStreak,
  habitSlots,
  toHabitSpec,
  toCheckins,
  streakUnitLabel,
  isExpectedToday,
  bucketKey,
  type ZeroHabitRow,
  type ZeroHabitCheckinRow,
} from "./adapt";

// --- Fixtures: build snake_case Zero rows with epoch-millis timestamps. ---

function habitRow(over: Partial<ZeroHabitRow> = {}): ZeroHabitRow {
  return {
    id: "h1",
    name: "Test habit",
    description: null,
    mode: "ongoing",
    target: 1,
    period: "day",
    days_of_week: null,
    bucket: null,
    color_index: 1,
    window_start: null,
    window_end: null,
    status: "active",
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

let checkinSeq = 0;
/** A Check-in row whose epoch-millis `ts` is local noon of y/m/d. */
function ci(y: number, m: number, d: number): ZeroHabitCheckinRow {
  const ts = new Date(y, m, d, 12, 0, 0).getTime();
  return {
    id: `c${checkinSeq++}`,
    habit_id: "h1",
    ts,
    note: null,
    created_at: ts,
  };
}

describe("toHabitSpec / toCheckins — the snake_case → camelCase + Date map", () => {
  it("renames days_of_week → daysOfWeek and converts window epoch-millis → Date", () => {
    const ws = new Date(2026, 0, 1).getTime();
    const we = new Date(2026, 1, 1).getTime();
    const spec = toHabitSpec(
      habitRow({
        period: "day",
        days_of_week: 0b0101010,
        mode: "bounded",
        window_start: ws,
        window_end: we,
        target: 3,
      }),
    );
    expect(spec).toMatchObject({
      mode: "bounded",
      period: "day",
      target: 3,
      daysOfWeek: 0b0101010,
    });
    expect(spec.windowStart).toBeInstanceOf(Date);
    expect(spec.windowStart!.getTime()).toBe(ws);
    expect(spec.windowEnd!.getTime()).toBe(we);
  });

  it("null window fields normalise to null Dates (not Invalid Date)", () => {
    const spec = toHabitSpec(habitRow({ window_start: null, window_end: null }));
    expect(spec.windowStart).toBeNull();
    expect(spec.windowEnd).toBeNull();
  });

  it("absent days_of_week normalises to null", () => {
    const spec = toHabitSpec(habitRow({ days_of_week: undefined }));
    expect(spec.daysOfWeek).toBeNull();
  });

  it("converts each Check-in's epoch-millis ts into a Date", () => {
    const ts = new Date(2026, 5, 15, 9, 30, 0).getTime();
    const out = toCheckins([{ id: "c", habit_id: "h1", ts, note: null, created_at: ts }]);
    expect(out[0].ts).toBeInstanceOf(Date);
    expect(out[0].ts.getTime()).toBe(ts);
  });
});

describe("habitStreak — AC9 day-Period, target=1, three states", () => {
  const now = new Date(2026, 5, 18, 8, 0, 0); // Thu Jun 18 2026, 08:00 local
  const row = habitRow({ period: "day", target: 1 });

  it("(a) dormant — empty log", () => {
    expect(habitStreak(row, [], now)).toMatchObject({
      state: "dormant",
      count: 0,
    });
  });

  it("(b) active_pending — 3 prior days, none today", () => {
    const checks = [ci(2026, 5, 15), ci(2026, 5, 16), ci(2026, 5, 17)];
    expect(habitStreak(row, checks, now)).toMatchObject({
      state: "active_pending",
      count: 3,
    });
  });

  it("(c) active_satisfied — same plus today", () => {
    const checks = [ci(2026, 5, 15), ci(2026, 5, 16), ci(2026, 5, 17), ci(2026, 5, 18)];
    expect(habitStreak(row, checks, now)).toMatchObject({
      state: "active_satisfied",
      count: 4,
    });
  });
});

describe("habitStreak — AC10 clock-boundary break (day-Period)", () => {
  const row = habitRow({ period: "day", target: 1 });
  // Check-ins through 2026-06-15, nothing after.
  const checks = [ci(2026, 5, 13), ci(2026, 5, 14), ci(2026, 5, 15)];

  it("holds while the next day is still open (now = Jun 16 08:00)", () => {
    const now = new Date(2026, 5, 16, 8, 0, 0);
    expect(habitStreak(row, checks, now)).toMatchObject({
      state: "active_pending",
      count: 3,
    });
  });

  it("breaks once Jun 16 has CLOSED unsatisfied (now = Jun 17 00:01)", () => {
    const now = new Date(2026, 5, 17, 0, 1, 0);
    expect(habitStreak(row, checks, now)).toMatchObject({
      state: "dormant",
      count: 0,
    });
  });
});

describe("habitStreak — AC11 immediate tick on satisfy (day-Period)", () => {
  const row = habitRow({ period: "day", target: 1 });
  const now = new Date(2026, 5, 18, 8, 0, 0);
  const prior = [ci(2026, 5, 15), ci(2026, 5, 16), ci(2026, 5, 17)];

  it("below target today → active_pending, count N", () => {
    expect(habitStreak(row, prior, now)).toMatchObject({
      state: "active_pending",
      count: 3,
    });
  });

  it("appending today's check-in at the same now → active_satisfied, N+1", () => {
    const withToday = [...prior, ci(2026, 5, 18)];
    expect(habitStreak(row, withToday, now)).toMatchObject({
      state: "active_satisfied",
      count: 4,
    });
  });
});

describe("habitStreak — AC12 month-Period, target=5", () => {
  const row = habitRow({ period: "month", target: 5 });
  const now = new Date(2026, 5, 18, 8, 0, 0); // Jun 18 2026

  function monthChecks(m: number, n: number): ZeroHabitCheckinRow[] {
    const out: ZeroHabitCheckinRow[] = [];
    for (let i = 1; i <= n; i++) out.push(ci(2026, m, i));
    return out;
  }

  it("(a) empty → dormant, 0", () => {
    expect(habitStreak(row, [], now)).toMatchObject({
      state: "dormant",
      count: 0,
    });
  });

  it("(b) 5 in Apr + 5 in May + 4 so far in Jun → active_pending, 2", () => {
    const checks = [
      ...monthChecks(3, 5), // April
      ...monthChecks(4, 5), // May
      ...monthChecks(5, 4), // June, below target
    ];
    expect(habitStreak(row, checks, now)).toMatchObject({
      state: "active_pending",
      count: 2,
      currentPeriodProgress: { filled: 4, target: 5 },
    });
  });

  it("(c) the 5th June check-in at the same now → active_satisfied, 3", () => {
    const checks = [...monthChecks(3, 5), ...monthChecks(4, 5), ...monthChecks(5, 5)];
    expect(habitStreak(row, checks, now)).toMatchObject({
      state: "active_satisfied",
      count: 3,
      currentPeriodProgress: { filled: 5, target: 5 },
    });
  });

  it("(break) an empty CLOSED month between runs → dormant, 0", () => {
    // Apr satisfied, May empty (closed), now in June → run is dead.
    const checks = monthChecks(3, 5);
    expect(habitStreak(row, checks, now)).toMatchObject({
      state: "dormant",
      count: 0,
    });
  });
});

describe("habitSlots — AC13 per-day-slash vs floating-quota-slash", () => {
  it("per-day: a past day with no Check-in resolves to slashed (closed)", () => {
    const row = habitRow({ period: "day", target: 1 });
    const past = new Date(2026, 5, 15, 12, 0, 0);
    const now = new Date(2026, 5, 18, 8, 0, 0);
    expect(habitSlots(row, [], past, now)).toMatchObject({
      slots: ["slashed"],
      overflow: 0,
      open: false,
    });
  });

  it("floating-quota: unfilled Slots are empty while the Period is OPEN", () => {
    const row = habitRow({ period: "week", target: 3 });
    // Week of Sun Jun 14 – Sat Jun 20; now inside it.
    const now = new Date(2026, 5, 18, 8, 0, 0);
    const checks = [ci(2026, 5, 15)]; // one Check-in this week
    expect(habitSlots(row, checks, now, now)).toMatchObject({
      slots: ["filled", "empty", "empty"],
      overflow: 0,
      open: true,
    });
  });

  it("floating-quota: unfilled Slots are slashed once the Period CLOSED", () => {
    const row = habitRow({ period: "week", target: 3 });
    const periodRef = new Date(2026, 5, 15, 12, 0, 0); // in the Jun 14–20 week
    const now = new Date(2026, 5, 25, 8, 0, 0); // next week → prior week closed
    const checks = [ci(2026, 5, 15)];
    expect(habitSlots(row, checks, periodRef, now)).toMatchObject({
      slots: ["filled", "slashed", "slashed"],
      overflow: 0,
      open: false,
    });
  });

  it("overflow counts Check-ins past Target as volume (+k)", () => {
    const row = habitRow({ period: "week", target: 2 });
    const now = new Date(2026, 5, 18, 8, 0, 0);
    const checks = [ci(2026, 5, 15), ci(2026, 5, 16), ci(2026, 5, 17)];
    const res = habitSlots(row, checks, now, now);
    expect(res.slots).toEqual(["filled", "filled"]);
    expect(res.overflow).toBe(1);
  });
});

describe("streakUnitLabel", () => {
  it("maps each Period to its headline unit", () => {
    expect(streakUnitLabel("day")).toBe("day streak");
    expect(streakUnitLabel("week")).toBe("week streak");
    expect(streakUnitLabel("month")).toBe("month streak");
    expect(streakUnitLabel("year")).toBe("year streak");
  });
});

describe("isExpectedToday — Today card scheduling", () => {
  // Thu Jun 18 2026 → getDay() === 4.
  const now = new Date(2026, 5, 18, 8, 0, 0);

  it("active every-day habit is expected", () => {
    expect(isExpectedToday(habitRow({ period: "day", days_of_week: null }), now)).toBe(true);
  });

  it("archived/completed/expired habits are never expected", () => {
    expect(isExpectedToday(habitRow({ status: "archived" }), now)).toBe(false);
    expect(isExpectedToday(habitRow({ status: "completed" }), now)).toBe(false);
    expect(isExpectedToday(habitRow({ status: "expired" }), now)).toBe(false);
  });

  it("weekday-masked day-habit is expected only on listed weekdays", () => {
    // Mask with Thursday (bit4) set → expected today.
    const withThu = habitRow({ period: "day", days_of_week: 1 << 4 });
    expect(isExpectedToday(withThu, now)).toBe(true);
    // Mask with Mon/Wed/Fri (bits 1,3,5) only → NOT expected on Thursday.
    const mwf = habitRow({
      period: "day",
      days_of_week: (1 << 1) | (1 << 3) | (1 << 5),
    });
    expect(isExpectedToday(mwf, now)).toBe(false);
  });

  it("week/month/year habits are expected every active day", () => {
    expect(isExpectedToday(habitRow({ period: "week", target: 3 }), now)).toBe(true);
    expect(isExpectedToday(habitRow({ period: "month", target: 5 }), now)).toBe(true);
  });

  it("bounded habit is gated to its window", () => {
    const before = habitRow({
      mode: "bounded",
      window_start: new Date(2026, 6, 1).getTime(), // July — after now
      window_end: new Date(2026, 7, 1).getTime(),
    });
    expect(isExpectedToday(before, now)).toBe(false);

    const open = habitRow({
      mode: "bounded",
      window_start: new Date(2026, 5, 1).getTime(),
      window_end: new Date(2026, 6, 1).getTime(), // window contains Jun 18
    });
    expect(isExpectedToday(open, now)).toBe(true);

    const after = habitRow({
      mode: "bounded",
      window_start: new Date(2026, 4, 1).getTime(),
      window_end: new Date(2026, 5, 1).getTime(), // ended before now
    });
    expect(isExpectedToday(after, now)).toBe(false);
  });
});

describe("bucketKey", () => {
  it("returns the bucket, defaulting null/absent to 'anytime'", () => {
    expect(bucketKey(habitRow({ bucket: "morning" }))).toBe("morning");
    expect(bucketKey(habitRow({ bucket: null }))).toBe("anytime");
    expect(bucketKey(habitRow({ bucket: undefined }))).toBe("anytime");
  });
});
