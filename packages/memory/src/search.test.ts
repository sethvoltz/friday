import { describe, expect, it, beforeEach, vi } from "vitest";
import type { MemoryEntry } from "./store.js";

let entries: MemoryEntry[] = [];

vi.mock("@friday/shared", () => ({
  getRawDb: () => ({
    prepare: () => {
      throw new Error("force fallback to full scan");
    },
  }),
}));

vi.mock("./store.js", () => ({
  listEntries: () => entries,
  touchRecall: () => {},
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

    const results = searchMemories({ query: "friday memory" });
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

    const results = searchMemories({ query: "daemon orchestrator" });
    expect(results.map((r) => r.entry.id)).toEqual(["split"]);
    const r = results[0];
    expect(r.matchedOn).toEqual(
      expect.arrayContaining(["title", "content"]),
    );
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

    const results = searchMemories({ query: "alpha" });
    // Tag exact-match (5) > title contains (3) > content contains (1).
    expect(results.map((r) => r.entry.id)).toEqual([
      "tag-hit",
      "title-hit",
      "content-hit",
    ]);
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

    const results = searchMemories({ query: "matches", tags: ["needed"] });
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

    const results = searchMemories({ query: "friday memory" });
    expect(results).toEqual([]);
  });
});
