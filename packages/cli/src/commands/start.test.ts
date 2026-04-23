import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock services module
const mockReadPid = vi.fn().mockReturnValue(null);
const mockWritePid = vi.fn();
const mockIsRunning = vi.fn().mockReturnValue(false);
const mockFindMonorepoRoot = vi.fn().mockReturnValue("/fake/root");
const mockParseServiceArg = vi.fn().mockReturnValue("daemon");

vi.mock("../services.js", () => ({
  SERVICES: {
    daemon: { label: "Friday daemon", package: "@friday/daemon", script: "start" },
    dashboard: { label: "Dashboard", package: "@friday/dashboard", script: "preview" },
  },
  readPid: (...args: any[]) => mockReadPid(...args),
  writePid: (...args: any[]) => mockWritePid(...args),
  isRunning: (...args: any[]) => mockIsRunning(...args),
  findMonorepoRoot: () => mockFindMonorepoRoot(),
  parseServiceArg: (...args: any[]) => mockParseServiceArg(...args),
}));

// Mock child_process spawn
const mockSpawn = vi.fn().mockReturnValue({ pid: 42, unref: vi.fn() });
vi.mock("node:child_process", () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

const { startCommand } = await import("./start.js");

describe("startCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMonorepoRoot.mockReturnValue("/fake/root");
    mockParseServiceArg.mockReturnValue("daemon");
    mockReadPid.mockReturnValue(null);
  });

  it("spawns a service and writes PID", () => {
    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    startCommand(["daemon"]);

    expect(mockSpawn).toHaveBeenCalledWith(
      "pnpm",
      ["--filter", "@friday/daemon", "run", "start"],
      expect.objectContaining({ cwd: "/fake/root", detached: true })
    );
    expect(mockWritePid).toHaveBeenCalledWith("daemon", 42);
    expect(logs.join("\n")).toContain("started (PID 42)");

    mock.mockRestore();
  });

  it("skips already-running service", () => {
    mockReadPid.mockReturnValue(999);
    mockIsRunning.mockReturnValue(true);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    startCommand(["daemon"]);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("already running");

    mock.mockRestore();
  });

  it("exits when monorepo root not found", () => {
    mockFindMonorepoRoot.mockReturnValue(null);
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
    const mockErr = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => startCommand(["daemon"])).toThrow("process.exit");

    mockExit.mockRestore();
    mockErr.mockRestore();
  });
});
