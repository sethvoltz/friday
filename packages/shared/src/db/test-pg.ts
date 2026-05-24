// Per-test Postgres scratch database harness (ADR-023, Phase 1 close).
//
// Each test file calls `createTestDb()` in beforeAll to get a unique
// scratch database, sets process.env.DATABASE_URL to it, then calls
// `dropTestDb()` in afterAll. Between tests, `truncateAllTables()`
// gives a deterministic clean slate without paying the cost of
// re-running the full migration set.
//
// The implementation reuses the daemon's actual migration runner +
// FTS_SETUP_SQL so test schema == production schema. There is no
// in-memory fallback: tests need a real Postgres reachable on the
// default socket (`pg_isready` must pass).
//
// **Important**: each test file must import this module and call
// `createTestDb()` BEFORE statically importing anything that calls
// `getDb()` or `getPool()` from `./client.js`. The client caches its
// pool on first use, and that pool binds to whatever `DATABASE_URL`
// was set at the time. Pattern:
//
//   const testDb = await createTestDb();
//   const { someService } = await import("./some-service.js");
//
// or use the `withTestDb()` helper which wraps the lifecycle.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pgPkg from "pg";
import { _resetClientForTests, closeDb } from "./client.js";
import { FTS_SETUP_SQL } from "./schema.js";

const { Client } = pgPkg;

export interface TestDbHandle {
  /** Connection string for the scratch DB. Already exported into
   *  process.env.DATABASE_URL when this handle was created. */
  databaseUrl: string;
  /** Drop the scratch DB. Idempotent; safe to call from afterAll even
   *  if creation partially failed. */
  drop(): Promise<void>;
  /** Wipe every app-managed table back to empty. Faster than recreating
   *  the schema between tests. Skips the BetterAuth `__drizzle_migrations`
   *  table — keeping its rows preserves migration cursor state. */
  truncate(): Promise<void>;
}

function adminUrl(): string {
  const user = process.env.USER ?? "postgres";
  return `postgresql://${user}@localhost:5432/postgres`;
}

function assertPgReady(): void {
  // Pass `-h localhost -p 5432` explicitly. Without args libpq falls
  // back to a Unix socket at `/var/run/postgresql/.s.PGSQL.5432`,
  // which doesn't exist on bare CI runners (the GitHub Actions
  // `services:` container exposes only TCP). On a developer's mac
  // running `brew services start postgresql@18` the socket DOES
  // exist, but TCP on 5432 is also available — the explicit args
  // make both environments take the TCP path. `PGHOST` env override
  // is still honored by libpq if the operator wants to point at a
  // non-default host (FRIDAY_PGHOST-style runtime config can be
  // added later if needed).
  const result = spawnSync("pg_isready", ["-h", "localhost", "-p", "5432"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `pg_isready failed (exit=${result.status}). Tests require a reachable Postgres. ` +
        `Start it with: brew services start postgresql@18`,
    );
  }
}

/**
 * Provision a scratch database and apply migrations. Sets
 * process.env.DATABASE_URL so the next `getDb()/getPool()` call binds
 * to this DB. Returns a handle with drop()/truncate() helpers.
 *
 * Database names are `friday_test_<hex>` to avoid colliding with the
 * user's real `friday` DB or with parallel test files.
 */
export async function createTestDb(opts?: {
  /** Optional name hint — useful when debugging which file leaked a
   *  scratch DB. Suffixed with random hex regardless. */
  label?: string;
}): Promise<TestDbHandle> {
  assertPgReady();

  // Suffix with crypto-random hex so parallel vitest workers never
  // collide. Lowercase per Postgres identifier convention.
  const suffix = randomBytes(6).toString("hex");
  const label = (opts?.label ?? "scratch").replace(/[^a-z0-9_]/g, "_");
  const dbName = `friday_test_${label}_${suffix}`.toLowerCase();

  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }

  const url = `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/${dbName}`;
  process.env.DATABASE_URL = url;
  // Force the singleton client to re-create against the new URL on
  // next access. Test files that imported `getDb` before this call
  // can still get a fresh binding by calling getDb() again post-create.
  _resetClientForTests();

  await applyMigrationsToScratch(url);

  return {
    databaseUrl: url,
    drop: () => dropTestDb(dbName),
    truncate: () => truncateAllTables(url),
  };
}

async function applyMigrationsToScratch(url: string): Promise<void> {
  // Reuse the production migration runner so the scratch schema is
  // structurally identical. Locate the journal relative to this
  // module's location (dist/db/test-pg.js → ../../drizzle).
  const { runMigrations } = await import("./migrate.js");
  // The runner reads `DATABASE_URL` via getPool(); we just set it above.
  await runMigrations();
  // FTS setup is idempotent and runs inside runMigrations(), but a
  // brand-new DB needs it to land before any test query reaches
  // content_tsv. Belt-and-braces.
  const pgPkgRetry = await import("pg");
  const c = new pgPkgRetry.default.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(FTS_SETUP_SQL);
  } finally {
    await c.end();
  }
}

async function dropTestDb(dbName: string): Promise<void> {
  // Close the pool first so Postgres lets us drop the DB it was
  // connected to.
  try {
    await closeDb();
  } catch {
    // Pool may not exist if the test never invoked getDb(). Fine.
  }
  _resetClientForTests();

  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    // WITH (FORCE) terminates lingering connections internally before
    // dropping — Postgres 13+, this codebase requires 18. Avoids the
    // race where pool.end() resolves while TCP sockets are still
    // draining: a separate pg_terminate_backend() on those in-flight
    // closes fires an unhandled 57P01 error in the Vitest process.
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

async function truncateAllTables(url: string): Promise<void> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    // Enumerate user tables (skip drizzle.__drizzle_migrations and
    // any system tables). `tablename` is a Postgres identifier so
    // dynamic interpolation is safe — `tablename` comes straight from
    // pg_tables which only returns valid identifiers.
    const r = await c.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename NOT LIKE 'sql_%'`,
    );
    if (r.rows.length === 0) return;
    const tables = r.rows.map((row) => `"${row.tablename}"`).join(", ");
    await c.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  } finally {
    await c.end();
  }
}

/**
 * Convenience wrapper: create a scratch DB, run `fn` with the handle,
 * always drop on exit. Useful for one-shot integration test files
 * that don't need a beforeAll/afterAll lifecycle.
 */
export async function withTestDb<T>(
  fn: (handle: TestDbHandle) => Promise<T>,
  opts?: { label?: string },
): Promise<T> {
  const handle = await createTestDb(opts);
  try {
    return await fn(handle);
  } finally {
    await handle.drop();
  }
}
