import { describe, it, expect, beforeEach } from "vitest";
import {
  recordTurnFiles,
  getRecentlyTouchedFiles,
  clearFileTracking,
  FILE_WINDOW_SIZE,
  _resetAllTracking,
} from "./file-tracker.js";

beforeEach(() => {
  _resetAllTracking();
});

describe("recordTurnFiles / getRecentlyTouchedFiles", () => {
  it("records files for a turn and returns them", () => {
    recordTurnFiles("agent-a", 1, ["/src/a.ts", "/src/b.ts"]);
    const result = getRecentlyTouchedFiles("agent-a");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ turn: 1, files: ["/src/a.ts", "/src/b.ts"] });
  });

  it("returns empty array for unknown agent", () => {
    expect(getRecentlyTouchedFiles("nobody")).toEqual([]);
  });

  it("returns entries in oldest-first order", () => {
    recordTurnFiles("agent-a", 1, ["/a.ts"]);
    recordTurnFiles("agent-a", 2, ["/b.ts"]);
    recordTurnFiles("agent-a", 3, ["/c.ts"]);
    const result = getRecentlyTouchedFiles("agent-a");
    expect(result.map((e) => e.turn)).toEqual([1, 2, 3]);
  });

  it("limits to turnsBack when specified", () => {
    recordTurnFiles("agent-a", 1, ["/a.ts"]);
    recordTurnFiles("agent-a", 2, ["/b.ts"]);
    recordTurnFiles("agent-a", 3, ["/c.ts"]);
    const result = getRecentlyTouchedFiles("agent-a", 2);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.turn)).toEqual([2, 3]);
  });

  it("returns all when turnsBack >= window length", () => {
    recordTurnFiles("agent-a", 1, ["/a.ts"]);
    recordTurnFiles("agent-a", 2, ["/b.ts"]);
    expect(getRecentlyTouchedFiles("agent-a", 10)).toHaveLength(2);
  });
});

describe("sliding window cap", () => {
  it(`drops oldest entry when window exceeds ${FILE_WINDOW_SIZE} turns`, () => {
    for (let i = 1; i <= FILE_WINDOW_SIZE + 1; i++) {
      recordTurnFiles("agent-a", i, [`/file-${i}.ts`]);
    }
    const result = getRecentlyTouchedFiles("agent-a");
    expect(result).toHaveLength(FILE_WINDOW_SIZE);
    // Oldest (turn 1) should have fallen off
    expect(result[0].turn).toBe(2);
    // Newest should still be present
    expect(result[result.length - 1].turn).toBe(FILE_WINDOW_SIZE + 1);
  });

  it("handles pushing N+5 turns (keeps only last window)", () => {
    for (let i = 1; i <= FILE_WINDOW_SIZE + 5; i++) {
      recordTurnFiles("agent-a", i, [`/file-${i}.ts`]);
    }
    const result = getRecentlyTouchedFiles("agent-a");
    expect(result).toHaveLength(FILE_WINDOW_SIZE);
    expect(result[0].turn).toBe(6); // first 5 dropped
  });
});

describe("multi-agent isolation", () => {
  it("tracks agents independently", () => {
    recordTurnFiles("agent-a", 1, ["/a.ts"]);
    recordTurnFiles("agent-b", 1, ["/b.ts"]);

    expect(getRecentlyTouchedFiles("agent-a")).toEqual([{ turn: 1, files: ["/a.ts"] }]);
    expect(getRecentlyTouchedFiles("agent-b")).toEqual([{ turn: 1, files: ["/b.ts"] }]);
  });
});

describe("clearFileTracking", () => {
  it("removes all tracking for the agent", () => {
    recordTurnFiles("agent-a", 1, ["/a.ts"]);
    recordTurnFiles("agent-a", 2, ["/b.ts"]);

    clearFileTracking("agent-a");
    expect(getRecentlyTouchedFiles("agent-a")).toEqual([]);
  });

  it("does not affect other agents", () => {
    recordTurnFiles("agent-a", 1, ["/a.ts"]);
    recordTurnFiles("agent-b", 1, ["/b.ts"]);

    clearFileTracking("agent-a");
    expect(getRecentlyTouchedFiles("agent-b")).toEqual([{ turn: 1, files: ["/b.ts"] }]);
  });

  it("is a no-op for unknown agent", () => {
    // Should not throw
    expect(() => clearFileTracking("nobody")).not.toThrow();
  });
});
