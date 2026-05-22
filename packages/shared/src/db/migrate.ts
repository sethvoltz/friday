// Postgres migration runner for the daemon's boot path (ADR-023).
//
// Mirrors the SQLite-era `runMigrations()` contract:
//   1. Apply any pending Drizzle migrations idempotently.
//   2. Apply the FTS_SETUP_SQL (generated tsvector columns + GIN indexes).
//   3. Assert journal count equals the row count in
//      drizzle.__drizzle_migrations. A mismatch indicates a fabricated
//      `when` timestamp poisoning the chain; fail loudly.
//
// Concurrency-safe: holds `pg_advisory_lock(0x4652494441590001)` during
// the apply step so concurrent boots (e.g., daemon + setup) don't race.
//
// Phase 1 note: this replaces the SQLite migrator that was called sync
// during boot. The signature returns Promise<void>; the daemon's
// startup code awaits it.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "./client.js";
import { FTS_SETUP_SQL } from "./schema.js";

const ADVISORY_LOCK_KEY = BigInt("0x4652494441590001");

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

/**
 * Apply pending migrations + ensure FTS columns exist. Idempotent.
 * Throws on journal/db mismatch (see assertJournalApplied).
 */
export async function runMigrations(): Promise<void> {
  const folder = locateMigrationsFolder();
  if (!folder) {
    // No migrations folder (e.g., bundled consumer); skip silently.
    return;
  }

  const journalPath = join(folder, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    throw new Error(`Drizzle journal missing at ${journalPath}`);
  }
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash TEXT NOT NULL,
        created_at BIGINT
      )
    `);

    await client.query(`SELECT pg_advisory_lock($1)`, [
      ADVISORY_LOCK_KEY.toString(),
    ]);
    try {
      const appliedRows = await client.query<{ created_at: string }>(
        `SELECT created_at FROM drizzle.__drizzle_migrations`,
      );
      const appliedWhens = new Set(
        appliedRows.rows.map((r) => Number(r.created_at)),
      );

      const sortedEntries = [...journal.entries].sort(
        (a, b) => a.when - b.when,
      );
      for (const entry of sortedEntries) {
        if (appliedWhens.has(entry.when)) continue;
        const sqlPath = join(folder, `${entry.tag}.sql`);
        if (!existsSync(sqlPath)) {
          throw new Error(
            `Migration file missing: ${sqlPath} (referenced by journal)`,
          );
        }
        const rawSql = readFileSync(sqlPath, "utf8");
        const statements = rawSql
          .split(/-->\s*statement-breakpoint/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        await client.query("BEGIN");
        try {
          for (const stmt of statements) {
            await client.query(stmt);
          }
          await client.query(
            `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
            [entry.tag, entry.when],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      }

      // FTS setup is idempotent (IF NOT EXISTS on the generated column +
      // GIN indexes). Run after every migration pass so schema changes
      // that add new tsvector targets flow through.
      await client.query(FTS_SETUP_SQL);
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [
        ADVISORY_LOCK_KEY.toString(),
      ]);
    }

    await assertJournalApplied(client, journal);
  } finally {
    client.release();
  }
}

/**
 * Drizzle's Postgres migrator (and our hand-rolled version above) tracks
 * applied migrations by `created_at` matching the journal `when`. If a
 * future migration's `when` is less than the current max (which happens
 * when someone hand-edits the journal with a fabricated value), it will
 * be silently skipped. Catch this by counting and fail loudly.
 */
async function assertJournalApplied(
  client: { query: (...args: unknown[]) => Promise<{ rows: unknown[] }> },
  journal: Journal,
): Promise<void> {
   
  const result = (await client.query(
    `SELECT COUNT(*)::int AS c FROM drizzle.__drizzle_migrations`,
  )) as { rows: { c: number }[] };
  const dbCount = result.rows[0]?.c ?? 0;
  if (dbCount === journal.entries.length) return;

   
  const applied = (await client.query(
    `SELECT created_at FROM drizzle.__drizzle_migrations`,
  )) as { rows: { created_at: string }[] };
  const appliedSet = new Set(applied.rows.map((r) => Number(r.created_at)));
  const missing = journal.entries.filter((e) => !appliedSet.has(e.when));
  const tags = missing.map((m) => `${m.tag} (when=${m.when})`).join(", ");
  throw new Error(
    `drizzle journal/db mismatch: ${journal.entries.length} entries in _journal.json, ` +
      `${dbCount} rows in drizzle.__drizzle_migrations. Likely cause: a journal entry's ` +
      `\`when\` is older than the current max \`created_at\` in __drizzle_migrations, ` +
      `so the migrator silently skipped it. Unapplied: ${tags}`,
  );
}

function locateMigrationsFolder(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // From dist/db/migrate.js → ../../drizzle (next to package.json)
  const candidates = [
    join(here, "..", "..", "drizzle"),
    join(here, "..", "..", "..", "drizzle"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}
