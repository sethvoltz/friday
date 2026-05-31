import { describe, expect, it, beforeEach, vi } from "vitest";
import type { MemoryEntry } from "./store.js";

let entries: MemoryEntry[] = [];

// Force the FTS path to throw so the scoring logic falls back to the
// full-scan branch. ADR-023 update: production code uses `getPool()`
// (returns pg.Pool whose `query` is awaitable); here we return a stub
// whose `query` rejects.
vi.mock("@friday/shared", () => ({
  getPool: () => ({
    query: () => Promise.reject(new Error("force fallback to full scan")),
  }),
}));

vi.mock("./store.js", () => ({
  listEntries: () => Promise.resolve(entries),
  touchRecall: () => Promise.resolve(),
}));

function mkEntry(partial: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    id: partial.id,
    title: partial.title ?? "",
    content: partial.content ?? "",
    tags: partial.tags ?? [],
    createdBy: "tester",
    createdAt: "2026-05-15T00:00:00Z",
    updatedAt: "2026-05-15T00:00:00Z",
    recallCount: partial.recallCount ?? 0,
    lastRecalledAt: null,
  };
}

beforeEach(() => {
  entries = [];
});

describe("searchMemories scoring", () => {
  it("multi-word query matches entry containing all tokens (AND)", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "a",
        title: "Friday memory subsystem",
        content: "discusses recall and storage details",
      }),
      mkEntry({
        id: "b",
        title: "Friday only",
        content: "no other token here",
      }),
    ];

    const results = await searchMemories({ query: "friday memory" });
    expect(results.map((r) => r.entry.id)).toEqual(["a"]);
    expect(results[0].matchedOn).toContain("title");
  });

  it("multi-word query matches when tokens are split across title and content", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "split",
        title: "Daemon architecture",
        content: "the orchestrator forks workers",
      }),
      mkEntry({
        id: "nomatch",
        title: "Daemon only",
        content: "nothing relevant",
      }),
    ];

    const results = await searchMemories({ query: "daemon orchestrator" });
    expect(results.map((r) => r.entry.id)).toEqual(["split"]);
    const r = results[0];
    expect(r.matchedOn).toEqual(expect.arrayContaining(["title", "content"]));
  });

  it("single-word query keeps prior scoring behavior", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "title-hit",
        title: "alpha topic",
        content: "unrelated body",
      }),
      mkEntry({
        id: "content-hit",
        title: "different",
        content: "the word alpha appears here",
      }),
      mkEntry({
        id: "tag-hit",
        title: "neither",
        content: "neither",
        tags: ["alpha"],
      }),
    ];

    const results = await searchMemories({ query: "alpha" });
    // Tag exact-match (5) > title contains (3) > content contains (1).
    expect(results.map((r) => r.entry.id)).toEqual(["tag-hit", "title-hit", "content-hit"]);
    expect(results[0].matchedOn).toEqual(["tag:alpha"]);
  });

  it("tag filter unchanged: rejects entries missing required tags", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "tagged",
        title: "matches query",
        content: "body",
        tags: ["needed", "extra"],
      }),
      mkEntry({
        id: "untagged",
        title: "matches query",
        content: "body",
        tags: ["other"],
      }),
    ];

    const results = await searchMemories({ query: "matches", tags: ["needed"] });
    expect(results.map((r) => r.entry.id)).toEqual(["tagged"]);
  });

  it("multi-word query excludes entries that match only one token", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "partial",
        title: "Friday docs",
        content: "no second token",
      }),
    ];

    const results = await searchMemories({ query: "friday memory" });
    expect(results).toEqual([]);
  });

  // FRI-34: when a tag filter is supplied, tags are the authoritative selector
  // and the query is a ranking signal only. Tag-matched entries must come back
  // even when the query token isn't anywhere in their title/content/tags.
  it("FRI-34: tag filter returns all tagged entries even when query token is absent", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "bucket-a",
        title: "alpha entry",
        content: "body about apples",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "bucket-b",
        title: "bravo entry",
        content: "body about bananas",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "bucket-c",
        title: "charlie entry",
        content: "body about cherries",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "bucket-d",
        title: "delta entry",
        content: "body about dates",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "bucket-e",
        title: "echo entry",
        content: "body about eggplant",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "noise",
        title: "unrelated",
        content: "no bucket here",
        tags: ["other:bucket"],
      }),
    ];

    const results = await searchMemories({ query: "foo", tags: ["test:bucket"] });
    expect(results.map((r) => r.entry.id).sort()).toEqual([
      "bucket-a",
      "bucket-b",
      "bucket-c",
      "bucket-d",
      "bucket-e",
    ]);
    // The untagged entry must not slip in.
    expect(results.map((r) => r.entry.id)).not.toContain("noise");
  });

  it("FRI-34: without tag filter, same query returns zero (AND-gate still applies)", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "bucket-a",
        title: "alpha entry",
        content: "body about apples",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "bucket-b",
        title: "bravo entry",
        content: "body about bananas",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "bucket-c",
        title: "charlie entry",
        content: "body about cherries",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "bucket-d",
        title: "delta entry",
        content: "body about dates",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "bucket-e",
        title: "echo entry",
        content: "body about eggplant",
        tags: ["test:bucket"],
      }),
    ];

    const results = await searchMemories({ query: "foo" });
    expect(results).toEqual([]);
  });

  it("FRI-34: query+tag matches rank above tag-only matches", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "tag-only",
        title: "alpha entry",
        content: "no relevant token here",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "title-and-tag",
        title: "foo handling",
        content: "no body match",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "content-and-tag",
        title: "delta entry",
        content: "the foo appears in body",
        tags: ["test:bucket"],
      }),
    ];

    const results = await searchMemories({ query: "foo", tags: ["test:bucket"] });
    // All three return; title-match (+3) outranks content-match (+1) which
    // outranks tag-only (score 0). Order: title-and-tag, content-and-tag, tag-only.
    expect(results.map((r) => r.entry.id)).toEqual([
      "title-and-tag",
      "content-and-tag",
      "tag-only",
    ]);
    expect(results[0].matchedOn).toContain("title");
    expect(results[1].matchedOn).toContain("content");
    expect(results[2].matchedOn).toEqual([]);
  });

  // Adjacent ranking bug noted in FRI-34: a `library` token should earn some
  // credit against an entry tagged `meal:library` even without a tag filter.
  it("FRI-34: substring tag match earns partial credit (+2), not zero", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "namespaced",
        title: "weekly menu",
        content: "library staples to keep stocked",
        tags: ["meal:library"],
      }),
      mkEntry({
        id: "no-tag",
        title: "the library list",
        content: "unrelated body",
      }),
    ];

    const results = await searchMemories({ query: "library" });
    const ids = results.map((r) => r.entry.id);
    expect(ids).toContain("namespaced");
    expect(ids).toContain("no-tag");
    // `namespaced` gets content (+1) + tag~ (+2) = 3 ≥ `no-tag` title-only (+3).
    // Both should appear; the namespaced entry's matchedOn must call out the
    // partial-tag hit so callers can see why it ranked.
    const namespaced = results.find((r) => r.entry.id === "namespaced")!;
    expect(namespaced.matchedOn).toEqual(expect.arrayContaining(["content", "tag~:meal:library"]));
  });
});
