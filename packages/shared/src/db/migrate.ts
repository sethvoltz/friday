import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync } from "node:fs";
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
  ensureFtsTables();
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
