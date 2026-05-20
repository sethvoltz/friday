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
