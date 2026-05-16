import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, getRawDb } from "./client.js";

/**
 * Apply pending migrations and ensure the FTS5 virtual tables + triggers
 * exist. Idempotent. Called by the daemon at startup; no-op when called
 * twice.
 */
export function runMigrations(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // From dist/db/migrate.js → ../../drizzle (next to package.json)
  const candidates = [
    join(here, "..", "..", "drizzle"),
    join(here, "..", "..", "..", "drizzle"),
  ];
  const folder = candidates.find((p) => existsSync(p));
  if (!folder) {
    // No migrations folder (e.g., bundled consumer); skip silently.
    ensureFtsTables();
    return;
  }
  migrate(getDb(), { migrationsFolder: folder });
  assertJournalApplied(folder);
  ensureFtsTables();
}

/**
 * Drizzle's SQLite migrator filters journal entries with
 * `lastDbMigration.created_at < migration.folderMillis` — so if any prior
 * migration recorded a `created_at` greater than a newer migration's `when`,
 * the newer one is silently skipped (no error, no log). This happens when a
 * journal entry's `when` was hand-authored with a future or fabricated value
 * instead of a real `Date.now()` from `drizzle-kit generate`.
 *
 * Compare the journal entry count to `__drizzle_migrations` row count after
 * each run. They must match. If they don't, fail loudly with the offenders
 * so the next boot doesn't quietly run on a half-migrated schema.
 */
function assertJournalApplied(folder: string): void {
  const journalPath = join(folder, "meta", "_journal.json");
  if (!existsSync(journalPath)) return;
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; tag: string; when: number }[];
  };
  const raw = getRawDb();
  const rows = raw
    .prepare("SELECT created_at FROM __drizzle_migrations ORDER BY id")
    .all() as { created_at: number }[];
  if (rows.length === journal.entries.length) return;
  const applied = new Set(rows.map((r) => r.created_at));
  const missing = journal.entries.filter((e) => !applied.has(e.when));
  const tags = missing.map((m) => `${m.tag} (when=${m.when})`).join(", ");
  throw new Error(
    `drizzle journal/db mismatch: ${journal.entries.length} entries in _journal.json, ` +
      `${rows.length} rows in __drizzle_migrations. Likely cause: a journal entry's ` +
      `\`when\` is older than the current max \`created_at\` in __drizzle_migrations, ` +
      `so drizzle's migrator silently skipped it. Unapplied: ${tags}`,
  );
}

function ensureFtsTables(): void {
  const raw = getRawDb();
  raw.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
      content_json, content='turns', content_rowid='id'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
      content_json, content='blocks', content_rowid='id'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      title, content, tags_json,
      content='memory_entries', content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
      INSERT INTO turns_fts(rowid, content_json) VALUES (new.id, new.content_json);
    END;
    CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
      INSERT INTO turns_fts(turns_fts, rowid, content_json)
        VALUES ('delete', old.id, old.content_json);
    END;
    CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
      INSERT INTO turns_fts(turns_fts, rowid, content_json)
        VALUES ('delete', old.id, old.content_json);
      INSERT INTO turns_fts(rowid, content_json) VALUES (new.id, new.content_json);
    END;

    CREATE TRIGGER IF NOT EXISTS blocks_ai AFTER INSERT ON blocks BEGIN
      INSERT INTO blocks_fts(rowid, content_json) VALUES (new.id, new.content_json);
    END;
    CREATE TRIGGER IF NOT EXISTS blocks_ad AFTER DELETE ON blocks BEGIN
      INSERT INTO blocks_fts(blocks_fts, rowid, content_json)
        VALUES ('delete', old.id, old.content_json);
    END;
    CREATE TRIGGER IF NOT EXISTS blocks_au AFTER UPDATE ON blocks BEGIN
      INSERT INTO blocks_fts(blocks_fts, rowid, content_json)
        VALUES ('delete', old.id, old.content_json);
      INSERT INTO blocks_fts(rowid, content_json) VALUES (new.id, new.content_json);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_fts(rowid, title, content, tags_json)
        VALUES (new.rowid, new.title, new.content, new.tags_json);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, content, tags_json)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags_json);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, content, tags_json)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags_json);
      INSERT INTO memory_fts(rowid, title, content, tags_json)
        VALUES (new.rowid, new.title, new.content, new.tags_json);
    END;
  `);
}
