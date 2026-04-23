import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadPid = vi.fn();
const mockRemovePid = vi.fn();
const mockIsRunning = vi.fn();
const mockParseServiceArg = vi.fn();

vi.mock("../services.js", () => ({
  SERVICES: {
    daemon: { label: "Friday daemon", package: "@friday/daemon", script: "start" },
    dashboard: { label: "Dashboard", package: "@friday/dashboard", script: "preview" },
  },
  readPid: (...args: any[]) => mockReadPid(...args),
  removePid: (...args: any[]) => mockRemovePid(...args),
  isRunning: (...args: any[]) => mockIsRunning(...args),
  parseServiceArg: (...args: any[]) => mockParseServiceArg(...args),
}));

const { stopCommand } = await import("./stop.js");

describe("stopCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseServiceArg.mockReturnValue("daemon");
  });

  it("sends SIGTERM and removes PID when service is running", () => {
    mockReadPid.mockReturnValue(12345);
    mockIsRunning.mockReturnValue(true);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    stopCommand(["daemon"]);

    expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(mockRemovePid).toHaveBeenCalledWith("daemon");
    expect(logs.join("\n")).toContain("stopped (PID 12345)");

    killSpy.mockRestore();
    mock.mockRestore();
  });

  it("cleans stale PID when process is not running", () => {
    mockReadPid.mockReturnValue(99999);
    mockIsRunning.mockReturnValue(false);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    stopCommand(["daemon"]);

    expect(mockRemovePid).toHaveBeenCalledWith("daemon");
    expect(logs.join("\n")).toContain("stale PID");

    mock.mockRestore();
  });

  it("reports not running when no PID file", () => {
    mockReadPid.mockReturnValue(null);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    stopCommand(["daemon"]);
    expect(logs.join("\n")).toContain("not running");

    mock.mockRestore();
  });
});
