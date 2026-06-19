// FRI-24 — scratch-DB verification that the pgvector schema lands end to
// end: the `vector` extension is created (test-pg.ts creates it as the OS
// superuser before migrations; prod creates it via ensureVectorExtension's
// admin connection in pg-provision), migration 0036 adds the
// `memory_entries.embedding` column typed `vector`, and FTS_SETUP_SQL
// builds the HNSW cosine index over it.
//
// Runs against a fresh scratch DB only (createTestDb → friday_test_*),
// never the host `friday` DB. Skips when Postgres isn't reachable.

import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findPgIsReady, ensureVectorExtension } from "./pg-provision.js";
import { createTestDb, newTestClient, type TestDbHandle } from "./test-pg.js";

function pgReachable(): boolean {
  return (
    spawnSync(findPgIsReady(), ["-h", "localhost", "-p", "5432"], { encoding: "utf8" }).status === 0
  );
}

const skip = !pgReachable();

describe.skipIf(skip)("FRI-24 pgvector schema (scratch DB)", () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await createTestDb({ label: "vector_schema" });
  });

  afterAll(async () => {
    await handle.drop();
  });

  it("creates the pgvector `vector` extension", async () => {
    const c = newTestClient({ connectionString: handle.databaseUrl });
    await c.connect();
    try {
      const r = await c.query<{ extname: string }>(
        `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
      );
      expect(r.rows).toEqual([{ extname: "vector" }]);
    } finally {
      await c.end();
    }
  });

  it("adds memory_entries.embedding as a `vector` column via migration 0036", async () => {
    const c = newTestClient({ connectionString: handle.databaseUrl });
    await c.connect();
    try {
      // udt_name is `vector` for a pgvector column; format_type pins the
      // declared dimensionality so we catch a drifted EMBEDDING_DIM.
      const r = await c.query<{ udt_name: string; formatted: string }>(
        `SELECT a.attname,
                t.typname AS udt_name,
                format_type(a.atttypid, a.atttypmod) AS formatted,
                a.attnotnull
           FROM pg_attribute a
           JOIN pg_type t ON t.oid = a.atttypid
          WHERE a.attrelid = 'memory_entries'::regclass
            AND a.attname = 'embedding'
            AND NOT a.attisdropped`,
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({
        udt_name: "vector",
        formatted: "vector(384)",
        // NULLABLE per design (populated by app code, not generated).
        attnotnull: false,
      });
    } finally {
      await c.end();
    }
  });

  it("builds the memory_entries_embedding_idx HNSW index over the embedding column", async () => {
    const c = newTestClient({ connectionString: handle.databaseUrl });
    await c.connect();
    try {
      // pg_indexes.indexdef is the canonical CREATE INDEX text; pg_am
      // confirms the access method is hnsw (not a fallback btree/gin).
      const r = await c.query<{ indexname: string; indexdef: string; amname: string }>(
        `SELECT i.indexname,
                i.indexdef,
                am.amname
           FROM pg_indexes i
           JOIN pg_class c ON c.relname = i.indexname
           JOIN pg_am am ON am.oid = c.relam
          WHERE i.tablename = 'memory_entries'
            AND i.indexname = 'memory_entries_embedding_idx'`,
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]?.amname).toBe("hnsw");
      expect(r.rows[0]?.indexdef).toContain("USING hnsw");
      expect(r.rows[0]?.indexdef).toContain("embedding");
      expect(r.rows[0]?.indexdef).toContain("vector_cosine_ops");
    } finally {
      await c.end();
    }
  });

  it("round-trips a 384-dim embedding through the vector column custom type", async () => {
    // Exercises the schema's toDriver/fromDriver marshalling against a real
    // pgvector column: insert a number[] embedding, read it back, assert the
    // exact vector survives. Pins the EMBEDDING_DIM-sized array end to end.
    const { getDb } = await import("./client.js");
    const { memoryEntries, EMBEDDING_DIM } = await import("./schema.js");
    const { eq } = await import("drizzle-orm");

    const db = getDb();
    const vec = Array.from({ length: EMBEDDING_DIM }, (_, i) => (i % 2 === 0 ? 0.25 : -0.5));
    const now = new Date();
    await db.insert(memoryEntries).values({
      id: "fri24-vec-roundtrip",
      title: "vec",
      content: "vec body",
      createdBy: "test",
      createdAt: now,
      updatedAt: now,
      fileMtime: now,
      embedding: vec,
    });

    const rows = await db
      .select({ embedding: memoryEntries.embedding })
      .from(memoryEntries)
      .where(eq(memoryEntries.id, "fri24-vec-roundtrip"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.embedding).toEqual(vec);
  });

  it("ensureVectorExtension creates the extension when absent and reports already-present on re-run", async () => {
    // Exercise BOTH branches of the prod helper at the layer the boot path
    // uses it. We point it at a SEPARATE scratch DB (connectionString
    // override) — never FRIDAY_DB — where the OS user is the superuser, so
    // the real CREATE EXTENSION path runs. createTestDb already creates the
    // extension on its scratch DB, so we drop it first to reach the absent
    // branch, then assert create→true, then re-run→false (idempotent).
    const second = await createTestDb({ label: "vector_ext_branches" });
    try {
      const drop = newTestClient({ connectionString: second.databaseUrl });
      await drop.connect();
      try {
        await drop.query(`DROP EXTENSION IF EXISTS vector CASCADE`);
        const after = await drop.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
        expect(after.rows).toHaveLength(0); // confirm we reached the absent branch
      } finally {
        await drop.end();
      }

      const created = await ensureVectorExtension(() => {}, second.databaseUrl);
      expect(created).toBe(true);

      // Extension now actually exists in that DB.
      const check = newTestClient({ connectionString: second.databaseUrl });
      await check.connect();
      try {
        const r = await check.query<{ extname: string }>(
          `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
        );
        expect(r.rows).toEqual([{ extname: "vector" }]);
      } finally {
        await check.end();
      }

      // Re-run is idempotent: present → false, no throw.
      const again = await ensureVectorExtension(() => {}, second.databaseUrl);
      expect(again).toBe(false);
    } finally {
      await second.drop();
    }
  });

  it('0036\'s ADD COLUMN fails with `type "vector" does not exist` when the extension is absent (AC1 negative)', async () => {
    // The one true ordering hazard the design guards against: migration 0036
    // references the `vector` type, which exists only after CREATE EXTENSION.
    // Prove that applying 0036's exact statement WITHOUT the extension throws —
    // this is why the extension is created (admin connection) BEFORE migrations
    // run, never inside 0036.
    const third = await createTestDb({ label: "vector_ext_absent" });
    try {
      const c = newTestClient({ connectionString: third.databaseUrl });
      await c.connect();
      try {
        // Reach the extension-absent state: drop the column 0036 added (+ its
        // HNSW index, cascaded) and then the extension itself.
        await c.query(`ALTER TABLE memory_entries DROP COLUMN IF EXISTS embedding`);
        await c.query(`DROP EXTENSION IF EXISTS vector CASCADE`);
        const present = await c.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
        expect(present.rows).toHaveLength(0); // confirm absent

        // Re-applying 0036's verbatim statement must now fail with the vector-type error.
        await expect(
          c.query(`ALTER TABLE "memory_entries" ADD COLUMN "embedding" vector(384)`),
        ).rejects.toThrow(/type "vector" does not exist/);
      } finally {
        await c.end();
      }
    } finally {
      await third.drop();
    }
  });
});

describe("FRI-24 migration journal integrity (AC4)", () => {
  it("idx-36 `when` is a real Date.now, strictly greater than the previous entry, not future, not rounded", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const journalPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "drizzle",
      "meta",
      "_journal.json",
    );
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const sorted = [...journal.entries].sort((a, b) => a.idx - b.idx);
    const last = sorted[sorted.length - 1];
    const prev = sorted[sorted.length - 2];
    expect(last.tag).toMatch(/^0036_/);
    expect(typeof last.when).toBe("number");
    expect(last.when).toBeGreaterThan(prev.when);
    expect(last.when).toBeLessThan(Date.now());
    // A real Date.now() in ms is not a multiple of 100000 — guards against a
    // fabricated/rounded `when` (the migration-discipline red flag).
    expect(last.when % 100000).not.toBe(0);
  });
});
