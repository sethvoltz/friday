/**
 * State-migrations runner (FRI-61).
 *
 * Drizzle's `runMigrations` handles schema migrations. This module runs
 * imperative one-shot data/filesystem migrations after the schema is in
 * place. Each migration carries a stable ID; once it's recorded in
 * `_friday_state_migrations`, subsequent boots short-circuit.
 *
 * Versioning convention: re-runs ship a NEW id (e.g. `agent-cwd-pin-v2`),
 * not mutations of the existing row. The applied rows are immutable
 * history, mirroring Drizzle's spirit.
 *
 * Concurrency: a Postgres advisory lock guards the runner so two daemons
 * (or daemon + setup CLI) booting in parallel don't fight. Distinct from
 * the schema-migration lock so the two can interleave safely.
 *
 * Failure handling: if a migration's `run()` throws, the runner re-raises
 * after logging. Boot aborts — operator must intervene rather than running
 * with half-migrated state. INSERT happens only after `run()` resolves, so
 * partial completion (script crashed midway through a sequence) leaves the
 * sentinel absent and the migration re-runs on next boot. Migrations are
 * therefore responsible for being idempotent if they can't complete
 * atomically.
 */

import { getPool } from "@friday/shared";
import { logger } from "../log.js";

/**
 * Lock key distinct from Drizzle's `0x4652494441590001`. The 4-byte
 * prefix `0x46524944` ("FRID") matches Drizzle's convention so a quick
 * `psql` SELECT on `pg_locks` makes the lock provenance obvious.
 */
const ADVISORY_LOCK_KEY = BigInt("0x4652494441590002");

export interface StateMigration {
  /** Stable ID; once recorded in `_friday_state_migrations`, this
   *  migration is permanently considered applied. */
  id: string;
  /** Idempotent migration body. Return value is stored as
   *  `meta_json` (counts, error lists, etc.) for audit. */
  run: () => Promise<Record<string, unknown>>;
}

export async function runStateMigrations(
  migrations: readonly StateMigration[],
): Promise<void> {
  if (migrations.length === 0) return;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock($1)`, [
      ADVISORY_LOCK_KEY.toString(),
    ]);
    try {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM _friday_state_migrations`,
      );
      const applied = new Set(rows.map((r) => r.id));
      for (const m of migrations) {
        if (applied.has(m.id)) {
          logger.log("debug", "state-migration.skip", { id: m.id });
          continue;
        }
        logger.log("info", "state-migration.start", { id: m.id });
        const meta = await m.run();
        await client.query(
          `INSERT INTO _friday_state_migrations (id, meta_json)
           VALUES ($1, $2)
           ON CONFLICT (id) DO NOTHING`,
          [m.id, JSON.stringify(meta)],
        );
        logger.log("info", "state-migration.done", { id: m.id, meta });
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [
        ADVISORY_LOCK_KEY.toString(),
      ]);
    }
  } finally {
    client.release();
  }
}
