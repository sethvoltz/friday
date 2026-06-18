// FRI-169 — Daemon streak-wiring mapping test (no Postgres).
//
// Pins that the daemon boundary correctly projects DB-shaped rows onto the
// pure engine (rowToSpec / rowsToCheckins) and merges the live { state, count }
// onto the habit (withStreak), injecting `now` HERE. The streak ALGORITHM is
// proven exhaustively in packages/shared/src/habits/streak.test.ts; this file
// proves the WIRING — that a Drizzle HabitRow + HabitCheckinRow[] flow through
// withStreak to the exact engine result for one day-Period and one
// month-Period habit (AC9 + AC12 at the daemon layer).
//
// No DB: the rows are hand-built in the DB shape ($inferSelect — camelCase,
// Date-typed timestamptz cols), so this runs in the fast `pnpm test` suite.

import { describe, expect, it } from "vitest";
import type { HabitCheckinRow, HabitRow } from "./store.js";
import { rowToSpec, rowsToCheckins, withStreak } from "./streak.js";

/** A fully-populated DB-shape habit row with overridable fields. */
function habitRow(overrides: Partial<HabitRow> = {}): HabitRow {
  const base = new Date("2026-01-01T00:00:00");
  return {
    id: "h1",
    name: "test",
    description: null,
    mode: "ongoing",
    target: 1,
    period: "day",
    daysOfWeek: null,
    bucket: null,
    colorIndex: null,
    windowStart: null,
    windowEnd: null,
    status: "active",
    createdAt: base,
    updatedAt: base,
    ...overrides,
  };
}

/** A DB-shape Check-in row at a local-time completion instant. */
function checkinRow(ts: Date, id = `c_${ts.getTime()}`): HabitCheckinRow {
  return { id, habitId: "h1", ts, note: null, createdAt: ts };
}

/** Local-midnight Date for a (y, m, d) — engine periods are local-time. */
function day(y: number, m: number, d: number, h = 9): Date {
  return new Date(y, m - 1, d, h, 0, 0, 0);
}

describe("daemon habit streak wiring (rowToSpec / withStreak)", () => {
  it("rowToSpec projects the DB row onto the engine's HabitSpec (enums + dates pass through)", () => {
    const ws = day(2026, 6, 1, 0);
    const we = day(2026, 7, 1, 0);
    const spec = rowToSpec(
      habitRow({
        mode: "bounded",
        period: "week",
        target: 3,
        daysOfWeek: 42,
        windowStart: ws,
        windowEnd: we,
      }),
    );
    expect(spec).toEqual({
      mode: "bounded",
      period: "week",
      target: 3,
      daysOfWeek: 42,
      windowStart: ws,
      windowEnd: we,
    });
  });

  it("rowsToCheckins projects Check-in rows onto CheckinLike[] (ts only)", () => {
    const t = day(2026, 6, 18);
    expect(rowsToCheckins([checkinRow(t)])).toEqual([{ ts: t }]);
  });

  // ---- day-Period, target=1 (AC9 at the wiring layer) ----

  it("day-Period: dormant when there are no Check-ins", () => {
    const row = habitRow({ period: "day", target: 1 });
    const out = withStreak(row, [], day(2026, 6, 18, 8));
    expect(out.streak).toMatchObject({ state: "dormant", count: 0 });
    // The decorated row preserves the habit fields and surfaces progress.
    expect(out.id).toBe("h1");
    expect(out.currentPeriodProgress).toEqual({ filled: 0, target: 1 });
  });

  it("day-Period: active_pending=3 — 3 prior consecutive days satisfied, today still open & empty", () => {
    const row = habitRow({ period: "day", target: 1 });
    const checkins = [
      checkinRow(day(2026, 6, 15)),
      checkinRow(day(2026, 6, 16)),
      checkinRow(day(2026, 6, 17)),
    ];
    const out = withStreak(row, checkins, day(2026, 6, 18, 8));
    expect(out.streak).toMatchObject({ state: "active_pending", count: 3 });
    expect(out.currentPeriodProgress).toEqual({ filled: 0, target: 1 });
  });

  it("day-Period: active_satisfied=4 — same 3 prior days plus today's Check-in", () => {
    const row = habitRow({ period: "day", target: 1 });
    const checkins = [
      checkinRow(day(2026, 6, 15)),
      checkinRow(day(2026, 6, 16)),
      checkinRow(day(2026, 6, 17)),
      checkinRow(day(2026, 6, 18, 7)),
    ];
    const out = withStreak(row, checkins, day(2026, 6, 18, 8));
    expect(out.streak).toMatchObject({ state: "active_satisfied", count: 4 });
    expect(out.currentPeriodProgress).toEqual({ filled: 1, target: 1 });
  });

  // ---- month-Period, target=5 (AC12 at the wiring layer) ----

  it("month-Period target=5: dormant when empty", () => {
    const row = habitRow({ period: "month", target: 5 });
    const out = withStreak(row, [], day(2026, 6, 18, 8));
    expect(out.streak).toMatchObject({ state: "dormant", count: 0 });
  });

  it("month-Period target=5: active_pending=2 — 5 in each of 2 prior months, 4 so far this month", () => {
    const row = habitRow({ period: "month", target: 5 });
    const checkins = [
      // April (prior month #2): 5 check-ins
      ...[3, 8, 12, 19, 25].map((d) => checkinRow(day(2026, 4, d), `apr_${d}`)),
      // May (prior month #1): 5 check-ins
      ...[2, 9, 14, 21, 28].map((d) => checkinRow(day(2026, 5, d), `may_${d}`)),
      // June (open month): only 4 so far
      ...[1, 5, 10, 15].map((d) => checkinRow(day(2026, 6, d), `jun_${d}`)),
    ];
    const out = withStreak(row, checkins, day(2026, 6, 18, 8));
    expect(out.streak).toMatchObject({ state: "active_pending", count: 2 });
    expect(out.currentPeriodProgress).toEqual({ filled: 4, target: 5 });
  });

  it("month-Period target=5: active_satisfied=3 — the 5th June Check-in ticks the open month", () => {
    const row = habitRow({ period: "month", target: 5 });
    const checkins = [
      ...[3, 8, 12, 19, 25].map((d) => checkinRow(day(2026, 4, d), `apr_${d}`)),
      ...[2, 9, 14, 21, 28].map((d) => checkinRow(day(2026, 5, d), `may_${d}`)),
      // June now has 5 → open month satisfied → N+1.
      ...[1, 5, 10, 15, 16].map((d) => checkinRow(day(2026, 6, d), `jun_${d}`)),
    ];
    const out = withStreak(row, checkins, day(2026, 6, 18, 8));
    expect(out.streak).toMatchObject({ state: "active_satisfied", count: 3 });
    expect(out.currentPeriodProgress).toEqual({ filled: 5, target: 5 });
  });

  it("month-Period target=5: an empty CLOSED month between runs breaks the streak to dormant", () => {
    const row = habitRow({ period: "month", target: 5 });
    const checkins = [
      // April satisfied, May EMPTY (a closed unsatisfied month), June below target.
      ...[3, 8, 12, 19, 25].map((d) => checkinRow(day(2026, 4, d), `apr_${d}`)),
      ...[1, 5].map((d) => checkinRow(day(2026, 6, d), `jun_${d}`)),
    ];
    const out = withStreak(row, checkins, day(2026, 6, 18, 8));
    // May closed unsatisfied → the April run is severed; June isn't satisfied.
    expect(out.streak).toMatchObject({ state: "dormant", count: 0 });
  });
});
