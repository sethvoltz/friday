import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, newTestClient, type TestDbHandle } from "@friday/shared";

// FRI-24: the embedder is mocked at the module boundary. `embedVector` is what
// embedText resolves to; `nullForIds` lets a test force specific entries to
// fail-open (embedText → null) so we can assert the skip path.
let embedVector: number[] = [];
let nullForIds = new Set<string>();

vi.mock("./embed.js", async () => {
  // Re-export the real timeout constant so backfill's import resolves, but
  // replace embedText. We don't need the real value; backfill only passes it
  // through to the (mocked) embedText.
  return {
    EMBED_WARM_TIMEOUT_MS: 120_000,
    embedText: (text: string) => {
      // text is `${title}\n${content}` → the title carries the id ("entry <id>").
      const m = /entry (\S+)/.exec(text);
      const id = m?.[1] ?? "";
      if (nullForIds.has(id)) return Promise.resolve(null);
      return Promise.resolve(embedVector);
    },
  };
});

let handle: TestDbHandle;

beforeAll(async () => {
  const { EMBEDDING_DIM } = await import("@friday/shared");
  embedVector = Array.from({ length: EMBEDDING_DIM }, (_, i) => (i % 5) * 0.01);
  handle = await createTestDb({ label: "memory_backfill" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  nullForIds = new Set();
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

describe("backfillEmbeddings (FRI-24)", () => {
  it("embeds every NULL-embedding ready entry and returns the counts", async () => {
    const { backfillEmbeddings } = await import("./backfill.js");
    const K = 7;
    for (let i = 0; i < K; i++) await seedReady(`e${i}`);

    const result = await backfillEmbeddings({ batchSize: 3 });

    expect(result).toEqual({ embedded: K, skipped: 0 });
    expect(await countEmbedded()).toBe(K);
  });

  it("skips an entry whose embed fails open (NULL) and leaves it unembedded", async () => {
    const { backfillEmbeddings } = await import("./backfill.js");
    await seedReady("ok-1");
    await seedReady("ok-2");
    await seedReady("fails");
    nullForIds = new Set(["fails"]);

    const result = await backfillEmbeddings();

    expect(result).toEqual({ embedded: 2, skipped: 1 });
    expect(await countEmbedded()).toBe(2);
  });

  it("does not re-embed an entry that already has an embedding (only NULLs are targeted)", async () => {
    const { backfillEmbeddings } = await import("./backfill.js");
    await seedReady("a");
    await seedReady("b");

    // First run embeds both.
    const first = await backfillEmbeddings();
    expect(first).toEqual({ embedded: 2, skipped: 0 });

    // Second run finds nothing NULL → embeds zero.
    const second = await backfillEmbeddings();
    expect(second).toEqual({ embedded: 0, skipped: 0 });
    expect(await countEmbedded()).toBe(2);
  });

  it("ignores non-ready entries", async () => {
    const { backfillEmbeddings } = await import("./backfill.js");
    const { getDb, schema } = await import("@friday/shared");
    const { eq } = await import("drizzle-orm");
    await seedReady("ready-row");
    await seedReady("deleted-row");
    const db = getDb();
    await db
      .update(schema.memoryEntries)
      .set({ status: "deleted" })
      .where(eq(schema.memoryEntries.id, "deleted-row"));

    const result = await backfillEmbeddings();

    expect(result).toEqual({ embedded: 1, skipped: 0 });
    expect(await countEmbedded()).toBe(1);
  });
});
