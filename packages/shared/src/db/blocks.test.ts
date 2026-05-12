import Database from "better-sqlite3";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Drive runMigrations() against an in-memory database by mocking the client
// module. We rebuild the handle fresh for each test so triggers and rows
// don't leak between cases.

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

function insertBlock(values: {
  block_id: string;
  turn_id?: string;
  agent_name?: string;
  session_id?: string;
  message_id?: string | null;
  block_index?: number;
  role?: string;
  kind?: string;
  source?: string | null;
  content_json: string;
  status?: string;
  ts?: number;
  last_event_seq?: number;
}): void {
  raw
    .prepare(
      `INSERT INTO blocks (block_id, turn_id, agent_name, session_id, message_id, block_index, role, kind, source, content_json, status, ts, last_event_seq)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      values.block_id,
      values.turn_id ?? "turn-default",
      values.agent_name ?? "alpha",
      values.session_id ?? "sess-default",
      values.message_id ?? null,
      values.block_index ?? 0,
      values.role ?? "assistant",
      values.kind ?? "text",
      values.source ?? null,
      values.content_json,
      values.status ?? "complete",
      values.ts ?? 1000,
      values.last_event_seq ?? 1,
    );
}

describe("blocks schema (FIX_FORWARD 1.1)", () => {
  it("runMigrations creates the blocks table and blocks_fts virtual table", async () => {
    const { runMigrations } = await import("./migrate.js");
    runMigrations();

    const tables = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('blocks','blocks_fts') ORDER BY name",
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(["blocks", "blocks_fts"]);
  });

  it("creates blocks_ai, blocks_au, blocks_ad triggers", async () => {
    const { runMigrations } = await import("./migrate.js");
    runMigrations();

    const triggers = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('blocks_ai','blocks_au','blocks_ad') ORDER BY name",
      )
      .all() as { name: string }[];
    expect(triggers.map((t) => t.name)).toEqual([
      "blocks_ad",
      "blocks_ai",
      "blocks_au",
    ]);
  });

  it("creates the documented secondary indexes on blocks", async () => {
    const { runMigrations } = await import("./migrate.js");
    runMigrations();

    const indexes = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='blocks' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = indexes.map((r) => r.name);
    expect(names).toContain("blocks_agent_ts");
    expect(names).toContain("blocks_session_msg");
    expect(names).toContain("blocks_turn");
    expect(names).toContain("blocks_block_id_unique");
  });

  it("INSERT populates blocks_fts via blocks_ai trigger", async () => {
    const { runMigrations } = await import("./migrate.js");
    runMigrations();

    insertBlock({
      block_id: "blk-1",
      content_json: '{"text":"hello uniqueHaystackToken world"}',
    });

    const match = raw
      .prepare(
        "SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH 'uniqueHaystackToken'",
      )
      .all() as { rowid: number }[];
    expect(match.length).toBe(1);
  });

  it("DELETE removes the FTS row via blocks_ad trigger", async () => {
    const { runMigrations } = await import("./migrate.js");
    runMigrations();

    insertBlock({
      block_id: "blk-2",
      content_json: '{"text":"deletableMarker"}',
    });
    raw.prepare("DELETE FROM blocks WHERE block_id = ?").run("blk-2");

    const match = raw
      .prepare(
        "SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH 'deletableMarker'",
      )
      .all() as { rowid: number }[];
    expect(match.length).toBe(0);
  });

  it("UPDATE refreshes the FTS row via blocks_au trigger", async () => {
    const { runMigrations } = await import("./migrate.js");
    runMigrations();

    insertBlock({
      block_id: "blk-3",
      content_json: '{"text":"beforeUpdateMarker"}',
      status: "streaming",
    });
    raw
      .prepare(
        `UPDATE blocks SET content_json = ?, status = ?, last_event_seq = ? WHERE block_id = ?`,
      )
      .run('{"text":"afterUpdateMarker"}', "complete", 4, "blk-3");

    const before = raw
      .prepare(
        "SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH 'beforeUpdateMarker'",
      )
      .all();
    const after = raw
      .prepare(
        "SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH 'afterUpdateMarker'",
      )
      .all() as { rowid: number }[];
    expect(before.length).toBe(0);
    expect(after.length).toBe(1);
  });

  it("UNIQUE constraint on block_id rejects duplicates", async () => {
    const { runMigrations } = await import("./migrate.js");
    runMigrations();

    insertBlock({ block_id: "blk-dupe", content_json: '{"text":"first"}' });
    expect(() =>
      insertBlock({
        block_id: "blk-dupe",
        block_index: 1,
        content_json: '{"text":"second"}',
        ts: 2,
        last_event_seq: 2,
      }),
    ).toThrow(/UNIQUE/i);
  });

  it("runMigrations is idempotent on a re-run", async () => {
    const { runMigrations } = await import("./migrate.js");
    runMigrations();
    expect(() => runMigrations()).not.toThrow();
  });
});
