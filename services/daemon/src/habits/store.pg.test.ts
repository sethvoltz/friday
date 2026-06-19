// FRI-169 — Habit store integration test (scratch Postgres).
//
// Exercises the daemon's habits data-access (./store.ts) end-to-end against a
// per-file `friday_test_*` scratch database (createTestDb), NEVER the host
// `friday` DB. The harness applies the full migration chain (incl. 0036) so
// the real `habits` / `habit_checkins` tables, their defaults, FK and check
// constraints are all in play.
//
// Proves the CONTEXT.md invariants at the store layer:
//   - create returns a fully-populated habit (server-supplied id + timestamps)
//   - insertCheckin is append-only (INSERT, never UPDATE/DELETE of priors)
//   - listCheckins reflects each insert
//   - deleteCheckin removes EXACTLY ONE row by id, leaving siblings intact
//     (AC14 — exact id-set equality, not just count)
//   - archiveHabit sets status='archived' and PRESERVES the row + its history
//
// Skipped when Postgres is unreachable (mirrors schema.habits.pg.test.ts /
// blocks.test.ts). When skipped the assertions below have NOT run.

import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, findPgIsReady, type TestDbHandle } from "@friday/shared";

function pgReachable(): boolean {
  return (
    spawnSync(findPgIsReady(), ["-h", "localhost", "-p", "5432"], { encoding: "utf8" }).status === 0
  );
}

const skip = !pgReachable();

describe.skipIf(skip)("FRI-169 habit store (scratch PG)", () => {
  let handle: TestDbHandle;
  // Imported AFTER createTestDb so the @friday/shared client binds to the
  // scratch DATABASE_URL (the getDb() pool caches its URL on first use).
  let store: typeof import("./store.js");

  beforeAll(async () => {
    handle = await createTestDb({ label: "habit-store" });
    store = await import("./store.js");
  });

  afterAll(async () => {
    await handle.drop();
  });

  beforeEach(async () => {
    await handle.truncate();
  });

  it("createHabit returns a fully-populated row with a server-supplied id + timestamps", async () => {
    const h = await store.createHabit({
      name: "brush teeth",
      mode: "ongoing",
      period: "day",
      target: 1,
      colorIndex: 3,
    });
    expect(typeof h.id).toBe("string");
    expect(h.id.length).toBeGreaterThan(0);
    expect(h.name).toBe("brush teeth");
    expect(h.mode).toBe("ongoing");
    expect(h.period).toBe("day");
    expect(h.target).toBe(1);
    expect(h.colorIndex).toBe(3);
    expect(h.status).toBe("active");
    expect(h.createdAt).toBeInstanceOf(Date);
    expect(h.updatedAt).toBeInstanceOf(Date);
  });

  it("listHabits('active') reflects a created habit; archiveHabit moves it to the archived filter without deleting it", async () => {
    const h = await store.createHabit({ name: "run", mode: "ongoing", period: "day" });
    const active = await store.listHabits("active");
    expect(active.map((x) => x.id)).toEqual([h.id]);
    expect(await store.listHabits("archived")).toEqual([]);

    const archived = await store.archiveHabit(h.id);
    expect(archived?.status).toBe("archived");
    // PRESERVE over delete: the row still exists, now under the archived filter.
    expect(await store.listHabits("active")).toEqual([]);
    expect((await store.listHabits("archived")).map((x) => x.id)).toEqual([h.id]);
    expect((await store.getHabit(h.id))?.status).toBe("archived");
  });

  it("insertCheckin is append-only and deleteCheckin removes EXACTLY ONE row by id (AC14)", async () => {
    const h = await store.createHabit({ name: "meditate", mode: "ongoing", period: "day" });

    // Seed N=2 Check-ins (ids a, b).
    const a = await store.insertCheckin(h.id, { ts: new Date("2026-06-16T09:00:00") });
    const b = await store.insertCheckin(h.id, { ts: new Date("2026-06-17T09:00:00") });
    let rows = await store.listCheckins(h.id);
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

    // INSERT a third (c) → N=3, priors untouched (append-only).
    const c = await store.insertCheckin(h.id, { ts: new Date("2026-06-18T09:00:00") });
    rows = await store.listCheckins(h.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id, c.id].sort());

    // UNDO c → exactly one row gone; a and b survive (exact id-set equality).
    const removed = await store.deleteCheckin(c.id);
    expect(removed).toBe(true);
    rows = await store.listCheckins(h.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

    // Deleting an unknown id removes nothing.
    expect(await store.deleteCheckin("no-such-id")).toBe(false);
    expect(await store.listCheckins(h.id)).toHaveLength(2);
  });

  it("insertCheckin defaults ts to now() when omitted and backdates when a past ts is supplied", async () => {
    const h = await store.createHabit({ name: "stretch", mode: "ongoing", period: "day" });
    const past = new Date("2025-01-01T12:00:00");
    const back = await store.insertCheckin(h.id, { ts: past });
    expect(back.ts.getTime()).toBe(past.getTime());

    const before = Date.now();
    const nowish = await store.insertCheckin(h.id);
    expect(nowish.ts.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("updateHabit patches only provided fields and bumps updatedAt", async () => {
    const h = await store.createHabit({ name: "old", mode: "ongoing", period: "day", target: 1 });
    const updated = await store.updateHabit(h.id, { name: "new", target: 3 });
    expect(updated?.name).toBe("new");
    expect(updated?.target).toBe(3);
    expect(updated?.period).toBe("day"); // untouched
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(h.updatedAt.getTime());
    expect(await store.updateHabit("no-such-id", { name: "x" })).toBeNull();
  });

  it("updateHabit clears days_of_week when period changes away from 'day' (orthogonality guard, no 400)", async () => {
    const h = await store.createHabit({
      name: "weekday-meds",
      mode: "ongoing",
      period: "day",
      daysOfWeek: 0b0101010, // Mon/Wed/Fri
    });
    expect(h.daysOfWeek).toBe(0b0101010);
    // Changing to a month-Period WITHOUT explicitly nulling the mask must succeed
    // (period wins; the mask is auto-cleared) rather than violating the check constraint.
    const updated = await store.updateHabit(h.id, { period: "month" });
    expect(updated?.period).toBe("month");
    expect(updated?.daysOfWeek).toBeNull();
  });
});
