// FRI-169 — Bounded-habit archival reconcile integration test (scratch PG).
//
// Proves the one blocking gap the adversarial review found: a Bounded Habit's
// window can close with NO write event, so without a sweep the row sits at
// status='active' forever. reconcileBoundedHabits() is the archival trigger —
// it flips closed-window Bounded Habits to their terminal status (completed |
// expired), reusing the pure streak engine's verdict (streak.ts:280-291).
//
// Runs against a per-file `friday_test_*` scratch database (createTestDb),
// NEVER the host `friday` DB. Skipped when Postgres is unreachable (mirrors
// store.pg.test.ts); when skipped the assertions below have NOT run.

import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, findPgIsReady, type TestDbHandle } from "@friday/shared";

function pgReachable(): boolean {
  return (
    spawnSync(findPgIsReady(), ["-h", "localhost", "-p", "5432"], { encoding: "utf8" }).status === 0
  );
}

const skip = !pgReachable();

// A day-aligned window of 7 day-Periods: Jun 1..Jun 7 (window_end is the
// exclusive close at Jun 8 00:00). `now` sits past the close.
const WINDOW_START = new Date(2026, 5, 1); // 2026-06-01 00:00 local
const WINDOW_END = new Date(2026, 5, 8); // 2026-06-08 00:00 local (exclusive)
const NOW_PAST_CLOSE = new Date(2026, 5, 9, 8, 0); // 2026-06-09 08:00 local
const NOW_BEFORE_CLOSE = new Date(2026, 5, 5, 8, 0); // 2026-06-05 08:00 — window still open

/** A Check-in at 09:00 on day `d` of June 2026. */
function checkinOnJune(d: number): Date {
  return new Date(2026, 5, d, 9, 0);
}

describe.skipIf(skip)("FRI-169 bounded-habit reconcile (scratch PG)", () => {
  let handle: TestDbHandle;
  // Imported AFTER createTestDb so @friday/shared binds to the scratch
  // DATABASE_URL (the getDb() pool caches its URL on first use).
  let store: typeof import("./store.js");
  let reconcile: typeof import("./reconcile.js");

  beforeAll(async () => {
    handle = await createTestDb({ label: "habit-reconcile" });
    store = await import("./store.js");
    reconcile = await import("./reconcile.js");
  });

  afterAll(async () => {
    await handle.drop();
  });

  beforeEach(async () => {
    await handle.truncate();
  });

  it("flips a bounded daily habit with a check-in every window day to status='completed'", async () => {
    const h = await store.createHabit({
      name: "completed-run",
      mode: "bounded",
      period: "day",
      target: 1,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });
    // A Check-in on every day of the window (Jun 1..7): the run is live at
    // window-close → completed.
    for (let d = 1; d <= 7; d++) {
      await store.insertCheckin(h.id, { ts: checkinOnJune(d) });
    }

    const tally = await reconcile.reconcileBoundedHabits(NOW_PAST_CLOSE);
    expect(tally).toEqual({ completed: 1, expired: 0 });
    expect((await store.getHabit(h.id))?.status).toBe("completed");
  });

  it("flips a bounded daily habit with a broken streak at close to status='expired'", async () => {
    const h = await store.createHabit({
      name: "expired-run",
      mode: "bounded",
      period: "day",
      target: 1,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });
    // Check-ins Jun 1..5, then Jun 6 AND Jun 7 missed → the run is broken at
    // window-close (closing period and its predecessor both unsatisfied) →
    // expired.
    for (let d = 1; d <= 5; d++) {
      await store.insertCheckin(h.id, { ts: checkinOnJune(d) });
    }

    const tally = await reconcile.reconcileBoundedHabits(NOW_PAST_CLOSE);
    expect(tally).toEqual({ completed: 0, expired: 1 });
    expect((await store.getHabit(h.id))?.status).toBe("expired");
  });

  it("leaves a bounded habit whose window is still in the FUTURE untouched (stays active)", async () => {
    const h = await store.createHabit({
      name: "future-window",
      mode: "bounded",
      period: "day",
      target: 1,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });
    for (let d = 1; d <= 4; d++) {
      await store.insertCheckin(h.id, { ts: checkinOnJune(d) });
    }

    // `now` sits BEFORE window_end → the row is not selected.
    const tally = await reconcile.reconcileBoundedHabits(NOW_BEFORE_CLOSE);
    expect(tally).toEqual({ completed: 0, expired: 0 });
    expect((await store.getHabit(h.id))?.status).toBe("active");
  });

  it("leaves an ongoing (non-bounded) active habit untouched (stays active)", async () => {
    const h = await store.createHabit({
      name: "ongoing-forever",
      mode: "ongoing",
      period: "day",
      target: 1,
    });
    await store.insertCheckin(h.id, { ts: checkinOnJune(3) });

    const tally = await reconcile.reconcileBoundedHabits(NOW_PAST_CLOSE);
    expect(tally).toEqual({ completed: 0, expired: 0 });
    expect((await store.getHabit(h.id))?.status).toBe("active");
  });

  it("is idempotent: a second pass leaves the already-terminal habit unchanged and selects 0 rows", async () => {
    const h = await store.createHabit({
      name: "idempotent-run",
      mode: "bounded",
      period: "day",
      target: 1,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });
    for (let d = 1; d <= 7; d++) {
      await store.insertCheckin(h.id, { ts: checkinOnJune(d) });
    }

    const first = await reconcile.reconcileBoundedHabits(NOW_PAST_CLOSE);
    expect(first).toEqual({ completed: 1, expired: 0 });
    expect((await store.getHabit(h.id))?.status).toBe("completed");
    const afterFirst = await store.getHabit(h.id);

    // Second pass: only status='active' rows are selected, so the now-completed
    // habit is never re-processed — tally is empty and the row is unchanged.
    const second = await reconcile.reconcileBoundedHabits(NOW_PAST_CLOSE);
    expect(second).toEqual({ completed: 0, expired: 0 });
    const afterSecond = await store.getHabit(h.id);
    expect(afterSecond?.status).toBe("completed");
    // updated_at was not bumped by the no-op second pass.
    expect(afterSecond?.updatedAt.getTime()).toBe(afterFirst?.updatedAt.getTime());
  });
});
