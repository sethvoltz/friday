// Regression test for the RC-1 teardown-race class (#109, #111, and this
// one). When a test file's `dropTestDb()` runs `pg_terminate_backend()`
// against its scratch DB, that FATAL can land on an *idle* pooled client
// of a DIFFERENT, still-open pool (the cross-file race that the daemon
// vitest `maxWorkers: 4` cap narrows but does not close). node-postgres'
// idle-error handler removes the client and RE-EMITS the error on the
// Pool object (`pool.emit("error", err, client)`). Without a Pool-level
// `error` listener, Node turns that into an unhandled exception and the
// Vitest process exits non-zero even though every test file passed —
// surfacing as an "Unhandled Error" on a pooled client carrying
// `_poolUseCount` / `release`. The #109/#111 guards covered the raw
// `pg.Client` socket and the `pool.on("remove")` path, but NOT the Pool's
// own re-emit, which is what this test pins.

import pgPkg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

import { createTestDb, type TestDbHandle } from "./test-pg.js";
import { findPgIsReady } from "./pg-provision.js";
import { getDb, getPool } from "./client.js";

const { Client } = pgPkg;

function pgReachable(): boolean {
  return (
    spawnSync(findPgIsReady(), ["-h", "localhost", "-p", "5432"], { encoding: "utf8" }).status === 0
  );
}

const skip = !pgReachable();

function adminUrl(): string {
  const user = process.env.USER ?? "postgres";
  return `postgresql://${user}@localhost:5432/postgres`;
}

describe.skipIf(skip)("client pool — idle-client teardown FATAL guard", () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await createTestDb({ label: "client_pool_guard" });
  });

  afterAll(async () => {
    await handle.drop();
  });

  it("a 57P01 on an idle pooled client does NOT become an uncaught exception", async () => {
    const dbName = new URL(handle.databaseUrl).pathname.replace(/^\//, "");

    // Bind the singleton pool to the scratch DB and run a query so a
    // connection is checked out, then released back to the pool as IDLE —
    // this is the exact shape of the client in the CI failure
    // (`_poolUseCount: 1`, a `release` fn, sitting idle in the pool).
    const db = getDb();
    await db.execute("SELECT 1");
    const pool = getPool();
    expect(pool.idleCount).toBeGreaterThanOrEqual(1);

    // Capture any uncaught exception / unhandled rejection that escapes
    // during the terminate window. If the guard regresses, the 57P01 lands
    // here and the assertion below fails (rather than aborting the whole
    // Vitest process, which is the real-world failure mode).
    const escaped: unknown[] = [];
    const onUncaught = (err: unknown) => escaped.push(err);
    const onRejection = (reason: unknown) => escaped.push(reason);
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onRejection);

    try {
      // Terminate the idle pooled backend from an admin connection — the
      // same call `dropTestDb()` issues. This is what another test file's
      // teardown does to a sibling pool's idle connection.
      const admin = new Client({ connectionString: adminUrl() });
      admin.on("error", () => {});
      await admin.connect();
      try {
        const killed = await admin.query<{ pid: number }>(
          `SELECT pg_terminate_backend(pid) AS pid FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName],
        );
        expect(killed.rows.length).toBeGreaterThanOrEqual(1);
      } finally {
        await admin.end();
      }

      // Let the FATAL propagate through the socket → pg-pool idle handler →
      // Pool `error` re-emit. The guard must swallow it.
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onRejection);
    }

    expect(escaped).toEqual([]);
  });
});
