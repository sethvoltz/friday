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
import { _resetClientForTests, closeDb, getPool } from "./client.js";
import { findPgIsReady } from "./pg-provision.js";
import { FTS_SETUP_SQL } from "./schema.js";

const { Client } = pgPkg;

/**
 * Construct a raw `pg.Client` with a baseline no-op `error` listener
 * already attached. Every test-side client MUST go through this.
 *
 * Why: `dropTestDb` (and the harness's walsender teardown) calls
 * `pg_terminate_backend()` against every session on a scratch DB. When
 * that lands on a `pg.Client` whose `client.end()` has returned but whose
 * TCP socket is still in the FIN handshake, the backend ships a 57P01
 * FATAL ("terminating connection due to administrator command"). A raw
 * `Client` with no `error` listener turns that socket-level FATAL into an
 * **unhandled exception** — Node aborts the whole process and Vitest
 * exits 1 even though every test passed. Under the unit `Tests` job each
 * file owns its own scratch DB; File A's terminate can race File B's
 * still-closing socket, so the crash shows up as a teardown flake far
 * from the file that "caused" it. The pool path is already guarded
 * (`client.ts` `pool.on("connect")`); this is the same guard for the raw
 * `Client` path. The handler is intentionally a no-op: these are
 * teardown-time socket FATALs after the query path has already resolved.
 */
export function newTestClient(config: pgPkg.ClientConfig): pgPkg.Client {
  const client = new Client(config);
  client.on("error", () => {
    // Intentionally swallowed — see doc comment. A late socket FATAL
    // (57P01 from pg_terminate_backend) after end()/query resolution
    // must not become an unhandled process-level exception.
  });
  return client;
}

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
  const result = spawnSync(findPgIsReady(), ["-h", "localhost", "-p", "5432"], {
    encoding: "utf8",
  });
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

  const admin = newTestClient({ connectionString: adminUrl() });
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
  // FRI-24: the `vector` extension must exist before migrations run —
  // 0036's `ADD COLUMN embedding vector(384)` depends on the type. In
  // production the extension is created via an admin (OS-superuser)
  // connection in pg-provision's ensureVectorExtension (the friday role
  // isn't superuser and pgvector 0.8.2 isn't trusted). The scratch URL
  // connects as the OS user — which IS the Homebrew-PG superuser — so we
  // can CREATE EXTENSION directly here before reusing the prod migrator.
  {
    const ext = newTestClient({ connectionString: url });
    await ext.connect();
    try {
      await ext.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    } finally {
      await ext.end();
    }
  }

  // Reuse the production migration runner so the scratch schema is
  // structurally identical. Locate the journal relative to this
  // module's location (dist/db/test-pg.js → ../../drizzle).
  const { runMigrations } = await import("./migrate.js");
  // The runner reads `DATABASE_URL` via getPool(); we just set it above.
  await runMigrations();
  // FTS setup is idempotent and runs inside runMigrations(), but a
  // brand-new DB needs it to land before any test query reaches
  // content_tsv. Belt-and-braces.
  const c = newTestClient({ connectionString: url });
  await c.connect();
  try {
    await c.query(FTS_SETUP_SQL);
  } finally {
    await c.end();
  }
}

async function dropTestDb(dbName: string): Promise<void> {
  // pg-pool calls client.removeAllListeners() before emitting 'remove'.
  // Hooking 'remove' is our last window to add an error handler on the
  // now-standalone client — without it, a 57P01 FATAL (sent when
  // pg_terminate_backend kills a connection that is still in the TCP
  // close handshake after pool.end()) becomes an unhandled exception in
  // the Vitest process.
  try {
    const pool = getPool();
    pool.on("remove", (client) => {
      client.on("error", () => {});
    });
  } catch {
    // Pool not yet initialized — nothing to attach to. Fine.
  }

  try {
    await closeDb();
  } catch {
    // Pool may not exist if the test never invoked getDb(). Fine.
  }
  _resetClientForTests();

  const admin = newTestClient({ connectionString: adminUrl() });
  await admin.connect();
  try {
    // Kill all other sessions on this DB so the DROP succeeds. This
    // also deactivates any Zero logical replication slots (active slots
    // can't be dropped while their consumer PID is alive).
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    // Drop replication slots now that their consumers are terminated.
    // A slot can still report active=true for a brief window after its
    // walsender backend is terminated (the backend exits asynchronously),
    // and pg_drop_replication_slot raises 55006 ("replication slot is
    // active for PID …") against an active slot. That 55006 used to throw
    // straight out of afterAll and leak the scratch DB. Re-terminate the
    // walsender + retry the slot-drop with backoff until it lands or the
    // slot is gone.
    await dropReplicationSlotsWithRetry(admin, dbName);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } finally {
    await admin.end();
  }
}

/**
 * Drop every logical-replication slot bound to `dbName`, retrying on
 * 55006 ("replication slot is active for PID …"). zero-cache's walsender
 * backend can outlive the OS-level SIGKILL by a short window; during that
 * window the slot reports `active=true` and a naive drop throws. Each
 * attempt re-terminates the active walsender PID before retrying the drop.
 */
async function dropReplicationSlotsWithRetry(
  admin: pgPkg.Client,
  dbName: string,
  attempts = 10,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await admin.query(
        `SELECT pg_drop_replication_slot(slot_name)
         FROM pg_replication_slots WHERE database = $1`,
        [dbName],
      );
      return; // all slots dropped (or none existed)
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      if (code !== "55006") throw err; // not the active-slot race — surface it
      // Slot still active — re-terminate its walsender and back off.
      try {
        await admin.query(
          `SELECT pg_terminate_backend(active_pid)
             FROM pg_replication_slots
             WHERE database = $1 AND active_pid IS NOT NULL`,
          [dbName],
        );
      } catch {
        /* walsender already gone — next loop's drop should succeed */
      }
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
  // Final attempt — if the slot is STILL active, let the error propagate
  // so DROP DATABASE's own failure isn't masked by a silently-skipped slot.
  await admin.query(
    `SELECT pg_drop_replication_slot(slot_name)
     FROM pg_replication_slots WHERE database = $1`,
    [dbName],
  );
}

async function truncateAllTables(url: string): Promise<void> {
  const c = newTestClient({ connectionString: url });
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
