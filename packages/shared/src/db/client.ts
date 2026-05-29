// Postgres + Drizzle client for Friday's canonical store (ADR-023).
//
// Connection pool sized for the daemon's expected concurrency (~10 simul-
// taneous queries from worker IPC + HTTP handlers + LISTEN). Use a single
// shared pool across the process — Node's pg lib handles concurrency well
// when one pool fronts every consumer.

import { drizzle } from "drizzle-orm/node-postgres";
import pgPkg from "pg";
import * as schema from "./schema.js";

const { Pool } = pgPkg;

export type FridayDb = ReturnType<typeof drizzle<typeof schema>>;
export type FridayPool = pgPkg.Pool;

let cached: { db: FridayDb; pool: FridayPool } | null = null;

/**
 * Returns the singleton Drizzle Postgres client. Idempotent. The pool is
 * sized for the daemon's expected concurrency; consumers don't need to
 * tune it. Throws if `DATABASE_URL` is missing — that's a setup error
 * (`friday setup` writes it to `~/.friday/.env`).
 */
export function getDb(): FridayDb {
  return getDbAndPool().db;
}

/**
 * Direct access to the `pg.Pool` for callers that need to issue raw SQL
 * via `pool.query(...)` (Drizzle's `sql` template + `db.execute` is the
 * preferred path; this is for the narrow cases like NOTIFY / LISTEN
 * that don't fit the query-builder model).
 */
export function getPool(): FridayPool {
  return getDbAndPool().pool;
}

/**
 * True when `err` is a Postgres admin-driven connection-teardown FATAL —
 * the backend was deliberately terminated or is shutting down. These are
 * expected and benign on the scratch-DB teardown path (a test file's
 * `pg_terminate_backend()` lands on an idle pooled connection of a still-
 * open pool). We match by SQLSTATE and, as a belt-and-braces fallback for
 * the (already-disconnected) cases where the driver doesn't surface a
 * code, by the canonical message text.
 *
 *   57P01 — admin_shutdown ("terminating connection due to administrator command")
 *   57P02 — crash_shutdown
 *   57P03 — cannot_connect_now
 */
const TEARDOWN_CLASS_CODES = new Set(["57P01", "57P02", "57P03"]);
function isTeardownClassError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && TEARDOWN_CLASS_CODES.has(code)) return true;
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return (
    typeof message === "string" &&
    /terminating connection due to administrator command/i.test(message)
  );
}

function getDbAndPool(): { db: FridayDb; pool: FridayPool } {
  if (cached) return cached;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Run `friday setup` to provision Postgres + write the URL to ~/.friday/.env.",
    );
  }
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // Late TCP-layer 'error' events on a pool client can fire AFTER the
  // pool has detached its own listeners — e.g. when an admin issues
  // `pg_terminate_backend()` against a backend whose local `client.end()`
  // has already returned but whose TCP FIN hasn't completed yet (the test
  // scratch-DB teardown path hits this). Without a baseline listener,
  // Node treats the orphan 'error' as an unhandled exception and crashes
  // the process — Vitest surfaces it as a job-level failure even when
  // every test file passed. The pool's own query/error routing is
  // unaffected: it installs its own 'error' listener for in-flight
  // queries; this is purely a safety net for socket-level FATALs after
  // the query path has already resolved.
  pool.on("connect", (client) => {
    client.on("error", () => {
      // Intentionally swallowed. See comment above.
    });
  });
  // Pool-level guard for the *idle pooled client* FATAL path. The
  // `pool.on("connect")` listener above guards the client socket while a
  // query is in flight, but it does NOT cover an idle client sitting in
  // the pool: when `pg_terminate_backend()` lands on an already-released
  // (idle) connection, node-postgres' own idle-error handler removes the
  // client AND RE-EMITS the error on the *Pool* (`pool.emit("error", err,
  // client)`). With no `error` listener on the Pool, Node turns that into
  // an unhandled exception and aborts the process — Vitest reports it as a
  // job-level "Unhandled Error" with `Test Files … passed` (the pooled
  // client carries `_poolUseCount`/`release`, and `_events.error` is
  // already 2 because the client-level guard fired but couldn't stop the
  // Pool re-emit). This is the residual of the RC-1 teardown-race class
  // that the #109/#111 raw-Client and `pool.on("remove")` guards did not
  // cover, because it lives on the Pool object, not the socket.
  //
  // We swallow ONLY teardown-class admin FATALs (57P01 terminate, 57P02
  // crash-shutdown, 57P03 cannot-connect-now) — every one of these means
  // "the backend went away," which during the scratch-DB teardown path is
  // expected and benign. Any other pool error is a real fault and is
  // re-thrown so it still surfaces.
  pool.on("error", (err) => {
    if (isTeardownClassError(err)) return;
    throw err;
  });
  const db = drizzle(pool, { schema });
  cached = { db, pool };
  return cached;
}

/**
 * Closes the pool and clears the singleton. Tests use this between
 * scratch-DB iterations; production uses it on daemon shutdown.
 */
export async function closeDb(): Promise<void> {
  if (cached) {
    const c = cached;
    cached = null;
    await c.pool.end();
  }
}

/**
 * Resets the singleton without closing the underlying pool — used by
 * test helpers that want a fresh client bound to a new DATABASE_URL.
 * The previous pool leaks unless the caller manages it; this is the
 * scratch-DB pattern's responsibility.
 */
export function _resetClientForTests(): void {
  cached = null;
}
