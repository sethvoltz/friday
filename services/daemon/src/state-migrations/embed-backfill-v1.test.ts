/**
 * FRI-24 AC6: the `embed-backfill-v1` state-migration, driven end-to-end
 * through the REAL `runStateMigrations` runner against a scratch Postgres
 * (createTestDb — never the host `friday` DB).
 *
 * Unit under test: the daemon WIRING — `embedBackfillV1` (the StateMigration
 * object) + its execution through `runStateMigrations`. The bug surface here is
 * "does the runner record the `embed-backfill-v1` sentinel on success, and does
 * a second boot short-circuit so the backfill never re-runs?" The embedding
 * runtime + the per-entry UPDATE internals are NOT this layer's concern — they
 * are covered at the source layer by `packages/memory/src/backfill.test.ts`
 * (which mocks `embedText`) and `embed.test.ts` (the fake IPC transport).
 *
 * So `@friday/memory`'s `backfillEmbeddings` is mocked at the package boundary
 * (it is a DEPENDENCY of the unit, not the unit itself). The mock performs the
 * SAME observable side effect the real one does — it UPDATEs `embedding` for
 * every NULL ready row in the scratch DB using a fake embedder — so the
 * `embedding IS NOT NULL` count is real, and the fake embedder's call count is
 * the AC6 "mock call count" assertion. We deliberately do NOT truncate between
 * the two runner passes: the second pass must observe the sentinel row the first
 * pass wrote, which is exactly the idempotency AC6 pins.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, newTestClient, EMBEDDING_DIM, type TestDbHandle } from "@friday/shared";

// Fake embedder: one call per NULL ready row. Returns a valid 384-float vector.
// `embedText.mock.calls.length` is the AC6 per-run embed-call count.
const embedText = vi.fn(async (_text: string) =>
  Array.from({ length: EMBEDDING_DIM }, (_, i) => (i % 5) * 0.01),
);

// `backfillEmbeddings` is mocked at the @friday/memory boundary (a dependency of
// embedBackfillV1, not the unit under test). The mock reproduces the real one's
// observable contract: walk every NULL-embedding ready row, embed it via the
// fake embedder, write the vector with the same `::vector` UPDATE the real
// implementation uses, and return {embedded, skipped}.
vi.mock("@friday/memory", () => ({
  backfillEmbeddings: vi.fn(async () => {
    const { getDb, getPool } = await import("@friday/shared");
    const { sql } = await import("drizzle-orm");
    const pool = getPool();
    const db = getDb();
    const rows = await pool.query<{ id: string; title: string; content: string }>(
      `SELECT id, title, content FROM memory_entries WHERE embedding IS NULL AND status = 'ready'`,
    );
    let embedded = 0;
    for (const row of rows.rows) {
      const vec = await embedText(`${row.title}\n${row.content}`);
      const literal = `[${vec.join(",")}]`;
      await db.execute(
        sql`UPDATE memory_entries SET embedding = ${literal}::vector WHERE id = ${row.id}`,
      );
      embedded += 1;
    }
    return { embedded, skipped: 0 };
  }),
  // The boot path also imports warmEmbeddingModel from this barrel; stub it so
  // the daemon module graph resolves even though this test never boots it.
  warmEmbeddingModel: vi.fn(async () => true),
}));

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "embed_backfill_v1" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  embedText.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedReady(id: string): Promise<void> {
  const { getDb, schema } = await import("@friday/shared");
  const db = getDb();
  const now = new Date();
  await db.insert(schema.memoryEntries).values({
    id,
    title: `entry ${id}`,
    content: `body of ${id}`,
    tagsJson: [],
    createdBy: "tester",
    createdAt: now,
    updatedAt: now,
    fileMtime: now,
    recallCount: 0,
    lastRecalledAt: null,
    status: "ready",
  });
}

async function countEmbedded(): Promise<number> {
  const c = newTestClient({ connectionString: handle.databaseUrl });
  await c.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM memory_entries WHERE embedding IS NOT NULL`,
    );
    return Number(r.rows[0].n);
  } finally {
    await c.end();
  }
}

async function stateMigrationRows(): Promise<string[]> {
  const c = newTestClient({ connectionString: handle.databaseUrl });
  await c.connect();
  try {
    const r = await c.query<{ id: string }>(`SELECT id FROM _friday_state_migrations ORDER BY id`);
    return r.rows.map((row) => row.id);
  } finally {
    await c.end();
  }
}

describe("embed-backfill-v1 state-migration (FRI-24 AC6)", () => {
  it("backfills every NULL embedding, records the sentinel, and the second pass embeds nothing", async () => {
    const { embedBackfillV1 } = await import("./embed-backfill-v1.js");
    const { runStateMigrations } = await import("./runner.js");

    const K = 5;
    for (let i = 0; i < K; i++) await seedReady(`e${i}`);
    expect(await countEmbedded()).toBe(0); // precondition: all NULL

    // --- Pass 1: the real runner drives the real embedBackfillV1 → backfill.
    await runStateMigrations([embedBackfillV1]);

    // (a) every ready entry now has an embedding.
    expect(await countEmbedded()).toBe(K);
    // The backfill reached embedText exactly K times (one per NULL ready row).
    expect(embedText).toHaveBeenCalledTimes(K);
    // (b) the sentinel row exists so later boots short-circuit.
    expect(await stateMigrationRows()).toContain("embed-backfill-v1");

    // --- Pass 2: a SECOND runner pass. The sentinel already exists → the runner
    // skips the migration entirely, so backfill never runs and ZERO embed calls
    // are issued.
    embedText.mockClear();
    await runStateMigrations([embedBackfillV1]);

    // (c) ZERO embedText calls on the re-run (the migration was skipped).
    expect(embedText).toHaveBeenCalledTimes(0);
    // Embeddings unchanged; sentinel still present exactly once.
    expect(await countEmbedded()).toBe(K);
    expect(await stateMigrationRows()).toEqual(["embed-backfill-v1"]);
  });
});
