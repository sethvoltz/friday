import Database from "better-sqlite3";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// FIX_FORWARD 5.1: ensure memory_ai/memory_au/memory_ad triggers mirror the
// blocks_* pattern. Drive runMigrations() against an in-memory DB.

let raw: Database.Database;

vi.mock("./client.js", async () => {
  const drizzleMod = await import("drizzle-orm/better-sqlite3");
  const schema = await import("./schema.js");
  return {
    getRawDb: () => raw,
    getDb: () => drizzleMod.drizzle(raw, { schema }),
    closeDb: () => {
      raw.close();
    },
  };
});

beforeEach(() => {
  raw = new Database(":memory:");
  raw.pragma("journal_mode = MEMORY");
  raw.pragma("foreign_keys = ON");
});

afterEach(() => {
  raw.close();
});

function insertMemoryEntry(values: {
  id: string;
  title: string;
  content: string;
  tags?: string[];
}): void {
  raw
    .prepare(
      `INSERT INTO memory_entries
         (id, title, content, tags_json, created_by, created_at, updated_at, file_mtime, recall_count, last_recalled_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      values.id,
      values.title,
      values.content,
      JSON.stringify(values.tags ?? []),
      "tester",
      "2026-05-12T00:00:00Z",
      "2026-05-12T00:00:00Z",
      0,
      0,
      null,
    );
}

describe("memory_fts triggers (FIX_FORWARD 5.1)", () => {
  it("runMigrations installs memory_ai/memory_au/memory_ad triggers", async () => {
    const { runMigrations } = await import("./migrate.js");
    runMigrations();
    const triggers = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('memory_ai','memory_au','memory_ad') ORDER BY name",
      )
      .all() as { name: string }[];
    expect(triggers.map((t) => t.name)).toEqual([
      "memory_ad",
      "memory_ai",
      "memory_au",
    ]);
  });

  it("INSERT into memory_entries populates memory_fts (title and content searchable)", async () => {
    const { runMigrations } = await import("./migrate.js");
    runMigrations();

    insertMemoryEntry({
      id: "mem-1",
      title: "uniqueMemoryTitleToken",
      content: "the body discusses uniqueMemoryBodyToken in detail",
      tags: ["alpha", "beta"],
    });

    const byTitle = raw
      .prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
      .all("uniqueMemoryTitleToken") as { rowid: number }[];
    expect(byTitle.length).toBe(1);

    const byContent = raw
      .prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
      .all("uniqueMemoryBodyToken") as { rowid: number }[];
    expect(byContent.length).toBe(1);
  });

  it("DELETE from memory_entries removes the FTS row (memory_ad)", async () => {
    const { runMigrations } = await import("./migrate.js");
    runMigrations();

    insertMemoryEntry({
      id: "mem-2",
      title: "deletableMemoryTitle",
      content: "body",
    });
    raw.prepare("DELETE FROM memory_entries WHERE id = ?").run("mem-2");

    const r = raw
      .prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
      .all("deletableMemoryTitle") as { rowid: number }[];
    expect(r.length).toBe(0);
  });

  it("UPDATE on memory_entries refreshes the FTS row (memory_au)", async () => {
    const { runMigrations } = await import("./migrate.js");
    runMigrations();

    insertMemoryEntry({
      id: "mem-3",
      title: "beforeMemoryTitle",
      content: "old body",
    });
    raw
      .prepare(
        `UPDATE memory_entries SET title = ?, content = ? WHERE id = ?`,
      )
      .run("afterMemoryTitle", "new body content", "mem-3");

    const before = raw
      .prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
      .all("beforeMemoryTitle") as { rowid: number }[];
    const after = raw
      .prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
      .all("afterMemoryTitle") as { rowid: number }[];
    expect(before.length).toBe(0);
    expect(after.length).toBe(1);
  });

  it("rebuild reconciles a populated entries table with an empty fts index", async () => {
    const { runMigrations } = await import("./migrate.js");
    runMigrations();

    // Pre-populate entries WITHOUT triggers active by tearing them down
    // first — emulates the legacy state before FIX_FORWARD 5.1.
    raw.exec(`
      DROP TRIGGER IF EXISTS memory_ai;
      DROP TRIGGER IF EXISTS memory_au;
      DROP TRIGGER IF EXISTS memory_ad;
    `);

    insertMemoryEntry({
      id: "mem-skip",
      title: "skippedAtInsertTitle",
      content: "skipped body",
    });
    // FTS is empty because the trigger wasn't there at insert time.
    const drifted = raw
      .prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
      .all("skippedAtInsertTitle") as { rowid: number }[];
    expect(drifted.length).toBe(0);

    // Re-run migrations (reinstalls triggers IF NOT EXISTS — they were
    // dropped, so they come back) and execute the rebuild command.
    runMigrations();
    raw.exec(`INSERT INTO memory_fts(memory_fts) VALUES('rebuild');`);

    const after = raw
      .prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?")
      .all("skippedAtInsertTitle") as { rowid: number }[];
    expect(after.length).toBe(1);
  });
});
