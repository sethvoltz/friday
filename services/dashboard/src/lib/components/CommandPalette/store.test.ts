/**
 * Tests for the command-palette recents persistence. Mocks the localStorage
 * boundary (loadJSON/saveJSON) so each test starts with a clean slate and
 * we can inspect what got written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadJSON = vi.fn();
const mockSaveJSON = vi.fn();
vi.mock("$lib/stores/persistent", () => ({
  loadJSON: mockLoadJSON,
  saveJSON: mockSaveJSON,
  KEYS: { paletteRecent: "palette:recent" },
}));

beforeEach(() => {
  mockLoadJSON.mockReset();
  mockSaveJSON.mockReset();
  mockLoadJSON.mockReturnValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CommandPaletteState.pushRecent", () => {
  it("dedupes by (kind, id) and moves the entry to the front", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { CommandPaletteState } = await import("./store.svelte");
    const s = new CommandPaletteState();
    s.pushRecent({ kind: "page", id: "/tickets" });
    vi.setSystemTime(2_000);
    s.pushRecent({ kind: "page", id: "/dashboard" });
    vi.setSystemTime(3_000);
    // Re-push the first entry. It must move to the front, NOT duplicate.
    s.pushRecent({ kind: "page", id: "/tickets" });

    expect(s.recents.map((r) => `${r.kind}:${r.id}`)).toEqual([
      "page:/tickets",
      "page:/dashboard",
    ]);
    expect(s.recents[0].ts).toBe(3_000);
  });

  it("caps the list at 6 entries after the 7th distinct push", async () => {
    const { CommandPaletteState } = await import("./store.svelte");
    const s = new CommandPaletteState();
    for (let i = 0; i < 7; i++) {
      s.pushRecent({ kind: "page", id: `/p${i}` });
    }
    // The seventh push evicts the oldest (/p0). Newest is at the front.
    expect(s.recents).toHaveLength(6);
    expect(s.recents[0].id).toBe("/p6");
    expect(s.recents.map((r) => r.id)).not.toContain("/p0");
  });

  it("writes the updated list to localStorage via saveJSON", async () => {
    const { CommandPaletteState } = await import("./store.svelte");
    const s = new CommandPaletteState();
    s.pushRecent({ kind: "agent", id: "alice" });
    // Pin the exact arguments: same key the dashboard reads on hydrate,
    // and a single-entry array.
    expect(mockSaveJSON).toHaveBeenCalledWith("palette:recent", [
      expect.objectContaining({ kind: "agent", id: "alice" }),
    ]);
  });
});

describe("CommandPaletteState.hydrate", () => {
  it("loads valid entries from storage and drops malformed ones", async () => {
    mockLoadJSON.mockReturnValue([
      { kind: "page", id: "/tickets", ts: 100 },
      { kind: "agent", id: "bob", ts: 200 },
      { kind: "invalid", id: "x", ts: 300 }, // bad kind — must be dropped
      { kind: "page", id: 42, ts: 400 }, // bad id — must be dropped
      null, // not an object
    ]);
    const { CommandPaletteState } = await import("./store.svelte");
    const s = new CommandPaletteState();
    s.hydrate();
    expect(s.recents.map((r) => `${r.kind}:${r.id}`)).toEqual([
      "page:/tickets",
      "agent:bob",
    ]);
  });

  it("is idempotent: a second call does not re-load or duplicate", async () => {
    mockLoadJSON.mockReturnValue([{ kind: "page", id: "/p1", ts: 100 }]);
    const { CommandPaletteState } = await import("./store.svelte");
    const s = new CommandPaletteState();
    s.hydrate();
    s.hydrate();
    expect(s.recents).toHaveLength(1);
    expect(mockLoadJSON).toHaveBeenCalledTimes(1);
  });
});

describe("CommandPaletteState open/close", () => {
  it("toggle flips state and openPalette resets the query", async () => {
    const { CommandPaletteState } = await import("./store.svelte");
    const s = new CommandPaletteState();
    s.query = "leftover";
    s.toggle();
    expect(s.open).toBe(true);
    expect(s.query).toBe("");
    s.toggle();
    expect(s.open).toBe(false);
  });
});
