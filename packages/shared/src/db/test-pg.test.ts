/**
 * Tests for the scratch-DB reclaim sweep (FRI-170, `sweepStaleTestDbs`).
 *
 * Skipped unless `pg_isready` reports a reachable Postgres (same gate as
 * pg-provision.test). Every DB this file touches is scoped to a unique
 * `friday_test_sweepcheck_<hex>` prefix and swept *only* by that prefix, so it
 * can never drop a sibling test file's scratch DB or the host `friday` DB —
 * even running in parallel.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pgPkg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findPgIsReady } from "./pg-provision.js";
import { newTestClient, sweepStaleTestDbs } from "./test-pg.js";

function pgReachable(): boolean {
  return (
    spawnSync(findPgIsReady(), ["-h", "localhost", "-p", "5432"], { encoding: "utf8" }).status === 0
  );
}
const skip = !pgReachable();

const adminUrl = `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/postgres`;
const dbUrl = (name: string) =>
  `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/${name}`;

describe.skipIf(skip)("sweepStaleTestDbs", () => {
  const tag = randomBytes(4).toString("hex");
  const prefix = `friday_test_sweepcheck_${tag}_`;
  const idleDb = `${prefix}idle`;
  const activeDb = `${prefix}active`;

  let admin: pgPkg.Client;
  let held: pgPkg.Client; // a live session on activeDb, kept open during the sweep

  async function dbExists(name: string): Promise<boolean> {
    const r = await admin.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists`,
      [name],
    );
    return r.rows[0]?.exists === true;
  }

  async function forceDrop(name: string): Promise<void> {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  }

  beforeAll(async () => {
    admin = newTestClient({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${idleDb}`);
    await admin.query(`CREATE DATABASE ${activeDb}`);
    // Open and pin a live session on activeDb so it shows up in pg_stat_activity.
    held = newTestClient({ connectionString: dbUrl(activeDb) });
    await held.connect();
    await held.query("SELECT 1");
  });

  afterAll(async () => {
    try {
      await held.end();
    } catch {
      /* may already be closed */
    }
    await forceDrop(activeDb);
    await forceDrop(idleDb);
    await admin.end();
  });

  it("drops the idle scratch DB and spares the one with a live session", async () => {
    const dropped = await sweepStaleTestDbs({ match: prefix });

    expect(dropped).toContain(idleDb);
    expect(dropped).not.toContain(activeDb);
    expect(await dbExists(idleDb)).toBe(false);
    expect(await dbExists(activeDb)).toBe(true);
  });

  it("becomes reclaimable once the session closes", async () => {
    await held.end();
    // Wait for the backend to clear out of pg_stat_activity before the sweep,
    // capturing the final count so a slow drain fails HERE (clear cause) rather
    // than later as a confusing "sweep didn't drop it".
    let sessions = "1";
    for (let i = 0; i < 50; i++) {
      const r = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = $1`,
        [activeDb],
      );
      sessions = r.rows[0]?.n ?? "1";
      if (sessions === "0") break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(sessions).toBe("0"); // backend drained — precondition for the sweep

    const dropped = await sweepStaleTestDbs({ match: prefix });

    expect(dropped).toContain(activeDb);
    expect(await dbExists(activeDb)).toBe(false);
  });
});
