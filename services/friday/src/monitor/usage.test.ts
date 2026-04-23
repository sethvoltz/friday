import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `friday-usage-test-${process.pid}-${Date.now()}`);
const logPath = join(testDir, "logs", "usage.jsonl");

vi.mock("@friday/shared", () => ({
  USAGE_LOG_PATH: logPath,
}));

// Must import after mock
const { logUsage } = await import("./usage.js");

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-04-22T12:00:00Z",
    channelId: "C123",
    sessionType: "orchestrator" as const,
    sessionId: "sess-1",
    costUsd: 0.05,
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    turnNumber: 1,
    durationMs: 1500,
    ...overrides,
  };
}

describe("logUsage", () => {
  beforeEach(() => {
    // Create both testDir and the logs subdirectory.
    // The module caches an `initialized` flag, so ensureLogDir is a no-op
    // after the first call — we must pre-create the parent dir ourselves.
    mkdirSync(join(testDir, "logs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates log directory and writes entry", () => {
    logUsage(makeEntry());

    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.channelId).toBe("C123");
    expect(parsed.inputTokens).toBe(100);
  });

  it("appends multiple entries", () => {
    logUsage(makeEntry({ sessionId: "sess-1" }));
    logUsage(makeEntry({ sessionId: "sess-2" }));

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).sessionId).toBe("sess-1");
    expect(JSON.parse(lines[1]).sessionId).toBe("sess-2");
  });

  it("preserves all fields in JSON output", () => {
    const entry = makeEntry({ costUsd: null, turnNumber: 3 });
    logUsage(entry);

    const parsed = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(parsed.costUsd).toBeNull();
    expect(parsed.turnNumber).toBe(3);
    expect(parsed.sessionType).toBe("orchestrator");
    expect(parsed.durationMs).toBe(1500);
  });
});
