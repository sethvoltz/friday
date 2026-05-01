import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Database as DatabaseType } from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { FridayDb } from "./client.js";

/**
 * Resolve the migrations folder relative to this file. Works from both:
 *   src/db/migrate.ts   (dev / tsx)        → ../../drizzle
 *   dist/db/migrate.js  (compiled output)  → ../../drizzle
 * Both resolve to packages/shared/drizzle.
 *
 * Returns null when the folder isn't present at the expected location —
 * e.g. when @friday/shared has been bundled into a downstream service
 * (dashboard via adapter-node) and the relative path no longer points at
 * the source-tree drizzle/ directory. The daemon owns migrations; other
 * processes opening the same DB can safely skip.
 */
function resolveMigrationsFolder(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const folder = join(here, "..", "..", "drizzle");
  if (!existsSync(join(folder, "meta", "_journal.json"))) return null;
  return folder;
}

/**
 * Apply pending migrations and ensure FTS5 tables/triggers exist.
 * Drizzle does not model FTS5 virtual tables, so they live in raw SQL
 * inside the migration file appended after the generated DDL.
 *
 * If the migrations folder isn't resolvable, skip the migrate step but
 * still re-assert the FTS5 schema (idempotent). This makes the dashboard
 * (which bundles shared via adapter-node) tolerant of being launched
 * before its own resolution can find the drizzle folder. The daemon —
 * running from `services/friday/dist/` with shared still co-located —
 * always resolves the folder and migrates as before.
 */
export function runMigrations(_db: FridayDb, raw: DatabaseType): void {
  const folder = resolveMigrationsFolder();
  if (folder) migrate(_db, { migrationsFolder: folder });
  ensureFts5(raw);
}

/**
 * Idempotent FTS5 setup. The migration SQL also creates these, but we
 * re-assert them defensively so a corrupted FTS5 table can be recovered
 * by deleting it and reopening the DB.
 */
function ensureFts5(raw: DatabaseType): void {
  raw.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      title, content, tags,
      content='memories',
      content_rowid='rowid'
    );
  `);
  raw.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END;
  `);
  raw.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    END;
  `);
  raw.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      INSERT INTO memories_fts(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END;
  `);
}
