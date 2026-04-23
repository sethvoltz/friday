import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadPid = vi.fn();
const mockWritePid = vi.fn();
const mockRemovePid = vi.fn();
const mockIsRunning = vi.fn();
const mockFindMonorepoRoot = vi.fn();

vi.mock("../services.js", () => ({
  SERVICES: {
    daemon: { label: "Friday daemon", package: "@friday/daemon", script: "start" },
    dashboard: { label: "Dashboard", package: "@friday/dashboard", script: "preview" },
  },
  readPid: (...args: any[]) => mockReadPid(...args),
  writePid: (...args: any[]) => mockWritePid(...args),
  removePid: (...args: any[]) => mockRemovePid(...args),
  isRunning: (...args: any[]) => mockIsRunning(...args),
  findMonorepoRoot: () => mockFindMonorepoRoot(),
}));

const mockSpawn = vi.fn().mockReturnValue({ pid: 77, unref: vi.fn() });
vi.mock("node:child_process", () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

const { restartCommand } = await import("./restart.js");

describe("restartCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMonorepoRoot.mockReturnValue("/fake/root");
    mockReadPid.mockReturnValue(null);
  });

  it("requires a service argument", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
    const mockErr = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => restartCommand([])).toThrow("process.exit");

    mockExit.mockRestore();
    mockErr.mockRestore();
  });

  it("stops running service then starts it", () => {
    mockReadPid.mockReturnValue(555);
    mockIsRunning.mockReturnValue(true);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    restartCommand(["daemon"]);

    expect(killSpy).toHaveBeenCalledWith(555, "SIGTERM");
    expect(mockRemovePid).toHaveBeenCalledWith("daemon");
    expect(mockSpawn).toHaveBeenCalled();
    expect(mockWritePid).toHaveBeenCalledWith("daemon", 77);
    const output = logs.join("\n");
    expect(output).toContain("stopped");
    expect(output).toContain("started");

    killSpy.mockRestore();
    mock.mockRestore();
  });

  it("rejects unknown service names", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
    const mockErr = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => restartCommand(["bogus"])).toThrow("process.exit");

    mockExit.mockRestore();
    mockErr.mockRestore();
  });
});
