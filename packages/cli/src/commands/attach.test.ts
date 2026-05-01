import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadState = vi.fn();
const mockParseServiceArg = vi.fn();
const mockHasSession = vi.fn();
const mockHasTmuxAvailable = vi.fn();
const mockSpawnSync = vi.fn();

vi.mock("../services.js", () => ({
  SERVICES: {
    daemon: { label: "Friday daemon", package: "@friday/daemon", script: "start" },
    dashboard: { label: "Dashboard", package: "@friday/dashboard", script: "start" },
  },
  parseServiceArg: (...args: any[]) => mockParseServiceArg(...args),
}));

vi.mock("../state.js", () => ({
  readState: (...args: any[]) => mockReadState(...args),
}));

vi.mock("../tmux.js", () => ({
  hasSession: (...args: any[]) => mockHasSession(...args),
  hasTmuxAvailable: () => mockHasTmuxAvailable(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: (...args: any[]) => mockSpawnSync(...args),
}));

const { attachCommand } = await import("./attach.js");

describe("attachCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasTmuxAvailable.mockReturnValue(true);
    mockSpawnSync.mockReturnValue({ status: 0 });
  });

  it("attaches when service is in dev mode with a live session", () => {
    mockParseServiceArg.mockReturnValue("dashboard");
    mockReadState.mockReturnValue({
      pid: 7001, mode: "dev", tmuxSession: "friday-dashboard",
      startedAt: "x", command: ["a"], logPath: "p",
    });
    mockHasSession.mockReturnValue(true);
    const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit(0)");
    }) as any);

    expect(() => attachCommand(["dashboard"])).toThrow("process.exit(0)");
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "tmux",
      ["attach", "-t", "friday-dashboard"],
      expect.objectContaining({ stdio: "inherit" })
    );

    exitMock.mockRestore();
  });

  it("errors when service is in prod mode", () => {
    mockParseServiceArg.mockReturnValue("dashboard");
    mockReadState.mockReturnValue({
      pid: 1, mode: "prod", startedAt: "x", command: ["a"], logPath: "p",
    });
    const errs: string[] = [];
    const errMock = vi.spyOn(console, "error").mockImplementation((m) => errs.push(String(m)));
    const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    expect(() => attachCommand(["dashboard"])).toThrow("process.exit");
    expect(errs.join("\n")).toContain("running in prod mode");
    expect(errs.join("\n")).toContain("friday logs dashboard -f");

    errMock.mockRestore();
    exitMock.mockRestore();
  });

  it("errors when service is not running", () => {
    mockParseServiceArg.mockReturnValue("daemon");
    mockReadState.mockReturnValue(null);
    const errs: string[] = [];
    const errMock = vi.spyOn(console, "error").mockImplementation((m) => errs.push(String(m)));
    const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    expect(() => attachCommand(["daemon"])).toThrow("process.exit");
    expect(errs.join("\n")).toContain("not running");

    errMock.mockRestore();
    exitMock.mockRestore();
  });

  it("rejects 'all' as a target", () => {
    mockParseServiceArg.mockReturnValue("all");
    const errMock = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    expect(() => attachCommand([])).toThrow("process.exit");

    errMock.mockRestore();
    exitMock.mockRestore();
  });
});
