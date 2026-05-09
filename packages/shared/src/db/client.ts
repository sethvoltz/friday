import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "../config.js";
import * as schema from "./schema.js";

export type FridayDb = ReturnType<typeof drizzle<typeof schema>>;

let cached: { db: FridayDb; raw: Database.Database } | null = null;

export function getDb(): FridayDb {
  return getDbAndRaw().db;
}

export function getRawDb(): Database.Database {
  return getDbAndRaw().raw;
}

function getDbAndRaw(): { db: FridayDb; raw: Database.Database } {
  if (cached) return cached;
  if (!existsSync(dirname(DB_PATH))) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
  }
  const raw = new Database(DB_PATH);
  raw.pragma("journal_mode = WAL");
  raw.pragma("synchronous = NORMAL");
  raw.pragma("busy_timeout = 5000");
  raw.pragma("foreign_keys = ON");
  const db = drizzle(raw, { schema });
  cached = { db, raw };
  return cached;
}

export function closeDb(): void {
  if (cached) {
    cached.raw.close();
    cached = null;
  }
}
