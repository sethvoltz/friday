import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `friday-memory-search-${process.pid}-${Date.now()}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testDir };
});

const { saveEntry, ensureMemoryDirs } = await import("./store.js");
const { searchMemories } = await import("./search.js");

describe("memory search", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    ensureMemoryDirs();

    saveEntry({
      title: "PostgreSQL decision",
      content: "We chose PostgreSQL over SQLite for the main database.",
      tags: ["architecture", "database"],
      createdBy: "orchestrator",
    });
    saveEntry({
      title: "API rate limiting",
      content: "Rate limit all external API calls to 100 req/min.",
      tags: ["architecture", "api"],
      createdBy: "orchestrator",
    });
    saveEntry({
      title: "Seth prefers terse responses",
      content: "Keep answers short, no hand-holding.",
      tags: ["user-preference"],
      createdBy: "orchestrator",
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("finds entries by keyword in title", () => {
    const results = searchMemories({ query: "PostgreSQL", trackRecall: false });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.title).toBe("PostgreSQL decision");
    expect(results[0].matchedOn).toContain("title");
  });

  it("finds entries by keyword in content", () => {
    const results = searchMemories({ query: "SQLite", trackRecall: false });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.title).toBe("PostgreSQL decision");
    expect(results[0].matchedOn).toContain("content");
  });

  it("finds entries by tag keyword", () => {
    const results = searchMemories({ query: "database", trackRecall: false });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.title).toBe("PostgreSQL decision");
    expect(results[0].matchedOn).toContain("tags");
  });

  it("filters by required tags", () => {
    const results = searchMemories({
      query: "architecture",
      tags: ["api"],
      trackRecall: false,
    });
    expect(results).toHaveLength(1);
    expect(results[0].entry.title).toBe("API rate limiting");
  });

  it("returns empty for no matches", () => {
    const results = searchMemories({
      query: "kubernetes deployment",
      trackRecall: false,
    });
    expect(results).toHaveLength(0);
  });

  it("respects limit", () => {
    const results = searchMemories({
      query: "architecture",
      limit: 1,
      trackRecall: false,
    });
    expect(results).toHaveLength(1);
  });

  it("increments recall count when trackRecall is true", () => {
    const results = searchMemories({ query: "PostgreSQL", trackRecall: true });
    expect(results[0].entry.recallCount).toBe(1);

    // Search again — recall count should increment
    const results2 = searchMemories({ query: "PostgreSQL", trackRecall: true });
    expect(results2[0].entry.recallCount).toBe(2);
  });

  it("boosts frequently recalled entries", () => {
    // Recall the API entry many times
    const apiEntry = searchMemories({ query: "API rate", trackRecall: true });
    for (let i = 0; i < 10; i++) {
      searchMemories({ query: "API rate", trackRecall: true });
    }

    // Now search for "architecture" — both entries match on tag,
    // but the API entry should rank higher due to recall boost
    const results = searchMemories({
      query: "architecture",
      trackRecall: false,
    });
    expect(results[0].entry.title).toBe("API rate limiting");
  });

  it("returns all entries with empty query when tags filter", () => {
    const results = searchMemories({
      query: "",
      tags: ["architecture"],
      trackRecall: false,
    });
    expect(results).toHaveLength(2);
  });
});
