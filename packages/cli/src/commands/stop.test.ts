import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadState = vi.fn();
const mockRemoveState = vi.fn();
const mockIsRunning = vi.fn();
const mockParseServiceArg = vi.fn();
const mockHasSession = vi.fn();
const mockKillSession = vi.fn();

vi.mock("../services.js", () => ({
  SERVICES: {
    daemon: { label: "Friday daemon", package: "@friday/daemon", script: "start" },
    dashboard: { label: "Dashboard", package: "@friday/dashboard", script: "start" },
  },
  isRunning: (...args: any[]) => mockIsRunning(...args),
  parseServiceArg: (...args: any[]) => mockParseServiceArg(...args),
}));

vi.mock("../state.js", () => ({
  readState: (...args: any[]) => mockReadState(...args),
  removeState: (...args: any[]) => mockRemoveState(...args),
}));

vi.mock("../tmux.js", () => ({
  hasSession: (...args: any[]) => mockHasSession(...args),
  killSession: (...args: any[]) => mockKillSession(...args),
}));

// Avoid the real `sleep` subprocess in tests.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const { stopCommand } = await import("./stop.js");

describe("stopCommand (prod)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseServiceArg.mockReturnValue("daemon");
  });

  it("SIGTERMs the inner pid, removes state, and reports stopped", () => {
    mockReadState.mockReturnValue({
      pid: 12345, mode: "prod", startedAt: "x", command: ["a"], logPath: "p",
    });
    // First call (after SIGTERM) reports running, second call reports gone.
    let calls = 0;
    mockIsRunning.mockImplementation(() => { calls += 1; return calls === 1; });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    stopCommand(["daemon"]);

    expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(mockRemoveState).toHaveBeenCalledWith("daemon");
    expect(logs.join("\n")).toContain("stopped (PID 12345)");

    killSpy.mockRestore();
    mock.mockRestore();
  });

  it("cleans stale state when process is not running", () => {
    mockReadState.mockReturnValue({
      pid: 99999, mode: "prod", startedAt: "x", command: ["a"], logPath: "p",
    });
    mockIsRunning.mockReturnValue(false);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    stopCommand(["daemon"]);

    expect(mockRemoveState).toHaveBeenCalledWith("daemon");
    expect(logs.join("\n")).toContain("stale state");

    mock.mockRestore();
  });

  it("reports not running when no state file exists", () => {
    mockReadState.mockReturnValue(null);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    stopCommand(["daemon"]);
    expect(logs.join("\n")).toContain("not running");

    mock.mockRestore();
  });
});

describe("stopCommand (dev)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseServiceArg.mockReturnValue("dashboard");
    mockHasSession.mockReturnValue(true);
  });

  it("SIGTERMs inner pid then kills the tmux session", () => {
    mockReadState.mockReturnValue({
      pid: 7001, panePid: 7000, mode: "dev",
      tmuxSession: "friday-dashboard",
      startedAt: "x", command: ["a"], logPath: "p",
    });
    let calls = 0;
    mockIsRunning.mockImplementation(() => { calls += 1; return calls === 1; });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const mock = vi.spyOn(console, "log").mockImplementation(() => {});

    stopCommand(["dashboard"]);

    expect(killSpy).toHaveBeenCalledWith(7001, "SIGTERM");
    expect(mockKillSession).toHaveBeenCalledWith("friday-dashboard");
    expect(mockRemoveState).toHaveBeenCalledWith("dashboard");

    killSpy.mockRestore();
    mock.mockRestore();
  });

  it("kills tmux session even when state is stale (process gone)", () => {
    mockReadState.mockReturnValue({
      pid: 99999, panePid: 99998, mode: "dev",
      tmuxSession: "friday-dashboard",
      startedAt: "x", command: ["a"], logPath: "p",
    });
    mockIsRunning.mockReturnValue(false);

    const mock = vi.spyOn(console, "log").mockImplementation(() => {});

    stopCommand(["dashboard"]);

    expect(mockKillSession).toHaveBeenCalledWith("friday-dashboard");
    expect(mockRemoveState).toHaveBeenCalledWith("dashboard");

    mock.mockRestore();
  });
});
