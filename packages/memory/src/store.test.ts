import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, newTestClient, type TestDbHandle } from "@friday/shared";

// FRI-24: the embedder is mocked at the module boundary so saveEntry's
// best-effort embed is fully controllable. `embedVector` is the value embedText
// resolves to; `embedThrows` makes it reject (to prove the embed is outside the
// durability path). Default `null` → embedding stays NULL.
let embedVector: number[] | null = null;
let embedThrows = false;

vi.mock("./embed.js", () => ({
  embedText: () =>
    embedThrows ? Promise.reject(new Error("embedder boom")) : Promise.resolve(embedVector),
}));

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "memory_store" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  embedVector = null;
  embedThrows = false;
});

async function seed(id: string, opts: { createdBy: string; tags: string[] }): Promise<void> {
  const { saveEntry } = await import("./store.js");
  const now = new Date().toISOString();
  await saveEntry({
    id,
    title: `entry ${id}`,
    content: `body of ${id}`,
    tags: opts.tags,
    createdBy: opts.createdBy,
    createdAt: now,
    updatedAt: now,
    recallCount: 0,
    lastRecalledAt: null,
  });
}

async function setStatus(id: string, status: string): Promise<void> {
  const { getDb, schema } = await import("@friday/shared");
  const { eq } = await import("drizzle-orm");
  const db = getDb();
  await db.update(schema.memoryEntries).set({ status }).where(eq(schema.memoryEntries.id, id));
}

describe("listPinnedForAgent (FRI-61)", () => {
  it("returns only entries tagged with the given tag, owned by the agent, status='ready'", async () => {
    const { listPinnedForAgent } = await import("./store.js");

    await seed("a", { createdBy: "friday", tags: ["pinned", "repo"] });
    await seed("b", { createdBy: "friday", tags: ["pinned"] });
    await seed("c", { createdBy: "friday", tags: ["other"] }); // wrong tag
    await seed("d", { createdBy: "kitchen", tags: ["pinned"] }); // wrong agent

    const pins = await listPinnedForAgent("friday");
    expect(pins.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list when no entries match", async () => {
    const { listPinnedForAgent } = await import("./store.js");

    await seed("solo", { createdBy: "friday", tags: ["other"] });

    const pins = await listPinnedForAgent("friday");
    expect(pins).toEqual([]);
  });

  it("excludes entries whose status is not 'ready'", async () => {
    const { listPinnedForAgent } = await import("./store.js");

    await seed("ready-row", { createdBy: "friday", tags: ["pinned"] });
    await seed("dead-row", { createdBy: "friday", tags: ["pinned"] });
    await setStatus("dead-row", "deleted");

    const pins = await listPinnedForAgent("friday");
    expect(pins.map((p) => p.id)).toEqual(["ready-row"]);
  });

  it("uses a custom tag name when provided", async () => {
    const { listPinnedForAgent } = await import("./store.js");

    await seed("repo-only", { createdBy: "friday", tags: ["repo"] });
    await seed("pinned-only", { createdBy: "friday", tags: ["pinned"] });

    const pinsByDefault = await listPinnedForAgent("friday");
    const pinsByRepo = await listPinnedForAgent("friday", "repo");

    expect(pinsByDefault.map((p) => p.id)).toEqual(["pinned-only"]);
    expect(pinsByRepo.map((p) => p.id)).toEqual(["repo-only"]);
  });

  it("orders results by id for byte-stable prompt assembly", async () => {
    const { listPinnedForAgent } = await import("./store.js");

    // Insert out of alphabetical order; verify sorted output.
    await seed("zzz", { createdBy: "friday", tags: ["pinned"] });
    await seed("aaa", { createdBy: "friday", tags: ["pinned"] });
    await seed("mmm", { createdBy: "friday", tags: ["pinned"] });

    const pins = await listPinnedForAgent("friday");
    expect(pins.map((p) => p.id)).toEqual(["aaa", "mmm", "zzz"]);
  });
});

describe("saveEntry embedding (FRI-24 AC5)", () => {
  // Read the raw embedding column as text (`[1,2,...]`) straight from Postgres,
  // bypassing the app-layer customType, so we observe exactly what was written.
  async function readEmbeddingText(id: string): Promise<string | null> {
    const c = newTestClient({ connectionString: handle.databaseUrl });
    await c.connect();
    try {
      const r = await c.query<{ embedding: string | null }>(
        `SELECT embedding::text AS embedding FROM memory_entries WHERE id = $1`,
        [id],
      );
      return r.rows[0]?.embedding ?? null;
    } finally {
      await c.end();
    }
  }

  async function save(id: string): Promise<void> {
    const { saveEntry } = await import("./store.js");
    const now = new Date().toISOString();
    await saveEntry({
      id,
      title: `entry ${id}`,
      content: `body of ${id}`,
      tags: [],
      createdBy: "tester",
      createdAt: now,
      updatedAt: now,
      recallCount: 0,
      lastRecalledAt: null,
    });
  }

  it("writes the vector and round-trips it when embedText returns a vector", async () => {
    const { EMBEDDING_DIM } = await import("@friday/shared");
    // A non-trivial deterministic vector of the correct dimensionality.
    const vec = Array.from({ length: EMBEDDING_DIM }, (_, i) => (i % 7) * 0.01 - 0.03);
    embedVector = vec;

    await save("with-embed");

    const text = await readEmbeddingText("with-embed");
    expect(text).not.toBeNull();
    // pgvector serializes as `[v0,v1,...]`; parse and compare to the source.
    const parsed = JSON.parse(text!) as number[];
    expect(parsed).toHaveLength(EMBEDDING_DIM);
    // pgvector stores float4 — compare with a tight tolerance.
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      expect(parsed[i]).toBeCloseTo(vec[i], 5);
    }
  });

  it("leaves embedding NULL when embedText returns null", async () => {
    embedVector = null;

    await save("no-embed");

    expect(await readEmbeddingText("no-embed")).toBeNull();
  });

  it("persists the .md file and the row (embedding NULL) when embedText throws", async () => {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { MEMORY_ENTRIES_DIR, getDb, schema } = await import("@friday/shared");
    const { eq } = await import("drizzle-orm");

    embedThrows = true;

    // Must not throw: the embed is outside the durability-critical path.
    await save("embed-throws");

    // The .md file landed.
    expect(existsSync(join(MEMORY_ENTRIES_DIR, "embed-throws.md"))).toBe(true);
    // The canonical row landed, with a NULL embedding.
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.memoryEntries)
      .where(eq(schema.memoryEntries.id, "embed-throws"));
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("entry embed-throws");
    expect(await readEmbeddingText("embed-throws")).toBeNull();
  });
});
