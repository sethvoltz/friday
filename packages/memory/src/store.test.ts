import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "memory_store" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

async function seed(
  id: string,
  opts: { createdBy: string; tags: string[] },
): Promise<void> {
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
  await db
    .update(schema.memoryEntries)
    .set({ status })
    .where(eq(schema.memoryEntries.id, id));
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
