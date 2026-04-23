import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `friday-status-test-${process.pid}-${Date.now()}`);
const fridayDir = join(testDir, ".friday");

vi.mock("@friday/shared", () => ({
  FRIDAY_DIR: fridayDir,
}));

// Mock services so we don't read real PID files
vi.mock("../services.js", () => ({
  SERVICES: {
    daemon: { label: "Friday daemon", package: "@friday/daemon", script: "start" },
    dashboard: { label: "Dashboard", package: "@friday/dashboard", script: "preview" },
  },
  readPid: vi.fn().mockReturnValue(null),
  isRunning: vi.fn().mockReturnValue(false),
  removePid: vi.fn(),
}));

const { statusCommand } = await import("./status.js");

describe("statusCommand", () => {
  beforeEach(() => {
    mkdirSync(fridayDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("reports services as not running when no PIDs", () => {
    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    statusCommand();
    const output = logs.join("\n");
    expect(output).toContain("Friday Status");
    expect(output).toContain("Friday daemon");
    expect(output).toContain("Dashboard");
    expect(output).toContain("\u2717"); // ✗ not running

    mock.mockRestore();
  });

  it("displays health info when health.json exists", () => {
    const healthData = {
      pid: 12345,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      uptimeMs: 120000,
    };
    writeFileSync(join(fridayDir, "health.json"), JSON.stringify(healthData));

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    statusCommand();
    const output = logs.join("\n");
    expect(output).toContain("Daemon health:");
    expect(output).toContain("PID:            12345");
    expect(output).toContain("2m 0s"); // 120000ms

    mock.mockRestore();
  });

  it("marks stale heartbeat", () => {
    const staleTime = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    writeFileSync(
      join(fridayDir, "health.json"),
      JSON.stringify({
        pid: 99, startedAt: staleTime,
        lastHeartbeat: staleTime, uptimeMs: 5000,
      })
    );

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    statusCommand();
    const output = logs.join("\n");
    expect(output).toContain("(stale)");

    mock.mockRestore();
  });
});
