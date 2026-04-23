import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `friday-usage-test-${process.pid}-${Date.now()}`);
const fridayDir = join(testDir, ".friday");
const usageLogPath = join(fridayDir, "usage.jsonl");

vi.mock("@friday/shared", () => ({
  USAGE_LOG_PATH: usageLogPath,
}));

const { usageCommand } = await import("./usage.js");

function makeEntry(overrides: Record<string, any> = {}) {
  return {
    timestamp: new Date().toISOString(),
    channelId: "C123",
    sessionType: "orchestrator",
    sessionId: "sess-1",
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 200,
    cacheReadTokens: 800,
    turnNumber: 1,
    durationMs: 3000,
    ...overrides,
  };
}

describe("usageCommand", () => {
  beforeEach(() => {
    mkdirSync(fridayDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("exits with error when no usage log exists", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => usageCommand([])).toThrow("process.exit");

    mockExit.mockRestore();
    mockError.mockRestore();
  });

  it("prints report for valid usage data", () => {
    const entries = [
      makeEntry({ costUsd: 0.01, sessionId: "s1" }),
      makeEntry({ costUsd: 0.02, sessionId: "s1", turnNumber: 2 }),
    ];
    writeFileSync(usageLogPath, entries.map((e) => JSON.stringify(e)).join("\n"));

    const logs: string[] = [];
    const mockLog = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg));
    });

    usageCommand([]);

    const output = logs.join("\n");
    expect(output).toContain("Friday Usage Report");
    expect(output).toContain("$0.0300"); // total cost
    expect(output).toContain("2 turns");
    expect(output).toContain("Cache hit rate:");
    expect(output).toContain("Orchestrator:");

    mockLog.mockRestore();
  });

  it("shows token breakdown in verbose mode", () => {
    writeFileSync(usageLogPath, JSON.stringify(makeEntry()));

    const logs: string[] = [];
    const mockLog = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg));
    });

    usageCommand(["-v"]);

    const output = logs.join("\n");
    expect(output).toContain("Token breakdown");
    expect(output).toContain("Input:");
    expect(output).toContain("Cache read:");

    mockLog.mockRestore();
  });

  it("separates today vs this week vs all time", () => {
    const now = new Date();
    const todayEntry = makeEntry({ costUsd: 0.05, timestamp: now.toISOString() });

    // 3 days ago
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const weekEntry = makeEntry({ costUsd: 0.10, timestamp: threeDaysAgo.toISOString() });

    // 30 days ago (outside week window)
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const oldEntry = makeEntry({ costUsd: 0.20, timestamp: monthAgo.toISOString() });

    writeFileSync(
      usageLogPath,
      [oldEntry, weekEntry, todayEntry].map((e) => JSON.stringify(e)).join("\n")
    );

    const logs: string[] = [];
    const mockLog = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg));
    });

    usageCommand([]);
    const output = logs.join("\n");

    // Today: $0.05 (1 turn)
    expect(output).toMatch(/Today\s+.*\$0\.0500.*1 turns/);
    // This week: $0.15 (2 turns — today + 3 days ago)
    expect(output).toMatch(/This week.*\$0\.1500.*2 turns/);
    // All time: $0.35 (3 turns)
    expect(output).toMatch(/All time.*\$0\.3500.*3 turns/);

    mockLog.mockRestore();
  });

  it("prints 'no activity' for today when all entries are old", () => {
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    writeFileSync(usageLogPath, JSON.stringify(makeEntry({ timestamp: monthAgo.toISOString() })));

    const logs: string[] = [];
    const mockLog = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    usageCommand([]);
    const output = logs.join("\n");
    expect(output).toMatch(/Today\s+: no activity/);

    mockLog.mockRestore();
  });

  it("skips malformed lines gracefully", () => {
    writeFileSync(
      usageLogPath,
      [JSON.stringify(makeEntry()), "not-json", ""].join("\n")
    );

    const logs: string[] = [];
    const mockLog = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg));
    });

    usageCommand([]);
    const output = logs.join("\n");
    expect(output).toContain("1 turns"); // Only valid entry counted

    mockLog.mockRestore();
  });
});
