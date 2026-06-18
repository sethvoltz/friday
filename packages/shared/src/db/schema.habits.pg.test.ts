// FRI-169 AC2 / AC3 / AC4 — habit table constraints against a scratch PG.
//
// Runs against a per-file `friday_test_*` scratch database (createTestDb),
// NEVER the host `friday` DB. The harness applies the full migration chain
// — including 0036_next_doctor_faustus — so:
//   - reaching this file at all proves AC4 (the new migration applies clean
//     and `runMigrations()`'s journal/db count assertion passes), and
//   - the CHECK constraints (AC2 color_index range, AC3 days_of_week ×
//     period orthogonality) are exercised with real INSERTs.
//
// Skipped when Postgres is unreachable (mirrors pg-provision.test.ts /
// blocks.test.ts). When skipped, the assertions below have NOT run — see
// the file's describe.skipIf guard.

import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findPgIsReady } from "./pg-provision.js";
import { createTestDb, newTestClient, type TestDbHandle } from "./test-pg.js";
import type pgPkg from "pg";

function pgReachable(): boolean {
  return (
    spawnSync(findPgIsReady(), ["-h", "localhost", "-p", "5432"], { encoding: "utf8" }).status === 0
  );
}

const skip = !pgReachable();

describe.skipIf(skip)("FRI-169 habit constraints (scratch PG)", () => {
  let handle: TestDbHandle;
  let client: pgPkg.Client;

  beforeAll(async () => {
    // createTestDb applies the full migration chain — including 0036 — to a
    // throwaway DB. Reaching afterAll without a journal/db-mismatch throw is
    // AC4's "applies clean, counts match" assertion.
    handle = await createTestDb({ label: "habits" });
    client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await handle.drop();
  });

  beforeEach(async () => {
    await handle.truncate();
  });

  async function insertHabit(overrides: Record<string, unknown>): Promise<void> {
    const row = {
      name: "test habit",
      mode: "ongoing",
      target: 1,
      period: "day",
      days_of_week: null,
      bucket: null,
      color_index: 1,
      status: "active",
      ...overrides,
    };
    await client.query(
      `INSERT INTO habits
         (name, mode, target, period, days_of_week, bucket, color_index, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), now())`,
      [
        row.name,
        row.mode,
        row.target,
        row.period,
        row.days_of_week,
        row.bucket,
        row.color_index,
        row.status,
      ],
    );
  }

  it("AC4: the 0036 migration applied and journal/db counts match (no mismatch throw at boot)", async () => {
    // If the migration chain were poisoned, createTestDb's runMigrations()
    // would have thrown in beforeAll. Confirm the tables physically exist.
    const r = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname='public' AND tablename IN ('habits','habit_checkins')
       ORDER BY tablename`,
    );
    expect(r.rows.map((x) => x.tablename)).toEqual(["habit_checkins", "habits"]);
  });

  it("AC2: a valid color_index (1 and 7 — the inclusive bounds) inserts", async () => {
    await expect(insertHabit({ color_index: 1 })).resolves.toBeUndefined();
    await expect(insertHabit({ color_index: 7 })).resolves.toBeUndefined();
  });

  it("AC2: color_index = 0 is rejected by habits_color_index_check", async () => {
    await expect(insertHabit({ color_index: 0 })).rejects.toThrow(/color_index/);
  });

  it("AC2: color_index = 8 is rejected by habits_color_index_check", async () => {
    await expect(insertHabit({ color_index: 8 })).rejects.toThrow(/color_index/);
  });

  it("AC2: mode / period / bucket / status enum checks reject out-of-domain values", async () => {
    await expect(insertHabit({ mode: "bogus" })).rejects.toThrow(/habits_mode_check/);
    await expect(insertHabit({ period: "fortnight" })).rejects.toThrow(/habits_period_check/);
    await expect(insertHabit({ bucket: "midnight" })).rejects.toThrow(/habits_bucket_check/);
    await expect(insertHabit({ status: "paused" })).rejects.toThrow(/habits_status_check/);
  });

  it("AC3: non-null days_of_week with period != 'day' is rejected by the orthogonality guard", async () => {
    await expect(
      insertHabit({ period: "month", days_of_week: 0b0101010 }),
    ).rejects.toThrow(/habits_days_of_week_period_check/);
  });

  it("AC3: period='day' with a non-null days_of_week succeeds and reads back the exact mask", async () => {
    const mask = 0b0101010; // 42 — Mon/Wed/Fri-ish sample mask
    await insertHabit({ period: "day", days_of_week: mask });
    const r = await client.query<{ days_of_week: number }>(
      `SELECT days_of_week FROM habits WHERE days_of_week IS NOT NULL`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.days_of_week).toBe(mask);
  });

  it("habit_checkins.habit_id FK rejects an insert referencing a non-existent habit", async () => {
    await expect(
      client.query(
        `INSERT INTO habit_checkins (habit_id, ts) VALUES ($1, now())`,
        ["no-such-habit-id"],
      ),
    ).rejects.toThrow(/habit_checkins_habit_id_habits_id_fk|foreign key/);
  });

  it("habit_checkins INSERT with only habit_id + ts auto-stamps id (uuid default) and created_at (now default)", async () => {
    // Mirrors what the `habitCheckin` mutator's canonical write does NOT
    // supply (id/created_at come from the column defaults). Proves the
    // append-only INSERT lands without the client synthesizing those.
    await insertHabit({ name: "ck-habit" });
    const h = await client.query<{ id: string }>(`SELECT id FROM habits LIMIT 1`);
    const habitId = h.rows[0]!.id;
    await client.query(`INSERT INTO habit_checkins (habit_id, ts) VALUES ($1, now())`, [habitId]);
    const r = await client.query<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM habit_checkins`,
    );
    expect(r.rows).toHaveLength(1);
    expect(typeof r.rows[0]!.id).toBe("string");
    expect(r.rows[0]!.id.length).toBeGreaterThan(0);
    expect(r.rows[0]!.created_at).toBeInstanceOf(Date);
  });
});
