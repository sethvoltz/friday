import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `friday-memory-${process.pid}-${Date.now()}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testDir };
});

const {
  saveEntry,
  getEntry,
  updateEntry,
  forgetEntry,
  listEntries,
  touchRecall,
  parseEntry,
  serializeEntry,
  ensureMemoryDirs,
  MEMORY_DIR,
} = await import("./store.js");

describe("memory store", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    ensureMemoryDirs();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("saves and retrieves an entry", () => {
    const entry = saveEntry({
      title: "Test Decision",
      content: "We chose PostgreSQL for persistence.",
      tags: ["architecture", "database"],
      createdBy: "orchestrator",
    });

    expect(entry.id).toBeTruthy();
    expect(entry.title).toBe("Test Decision");
    expect(entry.tags).toEqual(["architecture", "database"]);
    expect(entry.recallCount).toBe(0);

    const retrieved = getEntry(entry.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe("Test Decision");
    expect(retrieved!.content).toBe("We chose PostgreSQL for persistence.");
    expect(retrieved!.createdBy).toBe("orchestrator");
  });

  it("returns null for nonexistent entry", () => {
    expect(getEntry("does-not-exist")).toBeNull();
  });

  it("updates entry content and metadata", () => {
    const entry = saveEntry({
      title: "Original",
      content: "Original content",
      createdBy: "orchestrator",
    });

    const updated = updateEntry(entry.id, {
      title: "Updated Title",
      content: "New content",
      tags: ["changed"],
    });

    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Updated Title");
    expect(updated!.content).toBe("New content");
    expect(updated!.tags).toEqual(["changed"]);
    expect(updated!.updatedAt).toBeTruthy();
  });

  it("returns null when updating nonexistent entry", () => {
    expect(updateEntry("nope", { title: "x" })).toBeNull();
  });

  it("tracks recall count and timestamp", () => {
    const entry = saveEntry({
      title: "Recallable",
      content: "Some fact",
      createdBy: "orchestrator",
    });

    expect(entry.recallCount).toBe(0);
    expect(entry.lastRecalledAt).toBeNull();

    const recalled = touchRecall(entry.id);
    expect(recalled!.recallCount).toBe(1);
    expect(recalled!.lastRecalledAt).toBeTruthy();

    const recalled2 = touchRecall(entry.id);
    expect(recalled2!.recallCount).toBe(2);
  });

  it("forgets an entry", () => {
    const entry = saveEntry({
      title: "Forget Me",
      content: "Temporary",
      createdBy: "orchestrator",
    });

    expect(forgetEntry(entry.id)).toBe(true);
    expect(getEntry(entry.id)).toBeNull();
    expect(forgetEntry(entry.id)).toBe(false);
  });

  it("lists all entries", () => {
    saveEntry({ title: "First", content: "A", createdBy: "orch" });
    saveEntry({ title: "Second", content: "B", createdBy: "orch" });
    saveEntry({ title: "Third", content: "C", createdBy: "orch" });

    const all = listEntries();
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.title).sort()).toEqual(["First", "Second", "Third"]);
  });

  it("roundtrips through serialize/parse", () => {
    const entry = saveEntry({
      title: 'Quoted "Title"',
      content: "Multi-line\ncontent\nhere",
      tags: ["tag-one", "tag-two"],
      createdBy: "test-agent",
    });

    const serialized = serializeEntry(entry);
    const parsed = parseEntry(entry.id, serialized);

    expect(parsed.title).toBe('Quoted "Title"');
    expect(parsed.content).toBe("Multi-line\ncontent\nhere");
    expect(parsed.tags).toEqual(["tag-one", "tag-two"]);
    expect(parsed.createdBy).toBe("test-agent");
    expect(parsed.recallCount).toBe(0);
  });
});
