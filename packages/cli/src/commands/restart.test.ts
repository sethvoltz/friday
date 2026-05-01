import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadState = vi.fn();
const mockRemoveState = vi.fn();
const mockIsRunning = vi.fn();
const mockFindMonorepoRoot = vi.fn().mockReturnValue("/fake/root");
const mockHasSession = vi.fn().mockReturnValue(false);
const mockKillSession = vi.fn();
const mockLaunchProd = vi.fn().mockReturnValue(43);
const mockLaunchDev = vi.fn().mockReturnValue({ innerPid: 7002, sessionName: "friday-dashboard" });

vi.mock("../services.js", () => ({
  SERVICES: {
    daemon: { label: "Friday daemon" },
    dashboard: { label: "Dashboard" },
  },
  isRunning: (...args: any[]) => mockIsRunning(...args),
  findMonorepoRoot: () => mockFindMonorepoRoot(),
}));

vi.mock("../state.js", () => ({
  readState: (...args: any[]) => mockReadState(...args),
  removeState: (...args: any[]) => mockRemoveState(...args),
}));

vi.mock("../tmux.js", () => ({
  hasSession: (...args: any[]) => mockHasSession(...args),
  killSession: (...args: any[]) => mockKillSession(...args),
}));

vi.mock("../launch.js", () => ({
  launchProd: (...args: any[]) => mockLaunchProd(...args),
  launchDev: (...args: any[]) => mockLaunchDev(...args),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const { restartCommand } = await import("./restart.js");

describe("restartCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning.mockReturnValue(false);
    mockHasSession.mockReturnValue(false);
  });

  it("preserves prod mode when restarting a prod service", () => {
    mockReadState.mockReturnValue({
      pid: 100, mode: "prod", startedAt: "x", command: ["a"], logPath: "p",
    });
    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    restartCommand(["daemon"]);

    expect(mockLaunchProd).toHaveBeenCalledWith("daemon", "/fake/root");
    expect(mockLaunchDev).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Restarting Friday daemon in prod mode");

    mock.mockRestore();
  });

  it("preserves dev mode when restarting a dev service", () => {
    mockReadState.mockReturnValue({
      pid: 7001, panePid: 7000, mode: "dev",
      tmuxSession: "friday-dashboard",
      startedAt: "x", command: ["a"], logPath: "p",
    });
    mockHasSession.mockReturnValue(true);
    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    restartCommand(["dashboard"]);

    expect(mockLaunchDev).toHaveBeenCalledWith("dashboard", "/fake/root");
    expect(mockLaunchProd).not.toHaveBeenCalled();
    expect(mockKillSession).toHaveBeenCalledWith("friday-dashboard");
    expect(logs.join("\n")).toContain("Restarting Dashboard in dev mode");

    mock.mockRestore();
  });

  it("rejects --dev as an explicit flag (assertion mismatch)", () => {
    const errs: string[] = [];
    const errMock = vi.spyOn(console, "error").mockImplementation((m) => errs.push(String(m)));
    const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    expect(() => restartCommand(["daemon", "--dev"])).toThrow("process.exit");
    expect(errs.join("\n")).toContain("restart does not accept --dev");

    errMock.mockRestore();
    exitMock.mockRestore();
  });

  it("rejects --prod as an explicit flag", () => {
    const errs: string[] = [];
    const errMock = vi.spyOn(console, "error").mockImplementation((m) => errs.push(String(m)));
    const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    expect(() => restartCommand(["daemon", "--prod"])).toThrow("process.exit");
    expect(errs.join("\n")).toContain("restart does not accept --prod");

    errMock.mockRestore();
    exitMock.mockRestore();
  });

  it("errors when service is not running (no state)", () => {
    mockReadState.mockReturnValue(null);
    const errs: string[] = [];
    const errMock = vi.spyOn(console, "error").mockImplementation((m) => errs.push(String(m)));
    const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    expect(() => restartCommand(["daemon"])).toThrow("process.exit");
    expect(errs.join("\n")).toContain("not running");
    expect(errs.join("\n")).toContain("friday start daemon");

    errMock.mockRestore();
    exitMock.mockRestore();
  });

  it("errors when no service name supplied", () => {
    const errs: string[] = [];
    const errMock = vi.spyOn(console, "error").mockImplementation((m) => errs.push(String(m)));
    const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    expect(() => restartCommand([])).toThrow("process.exit");
    expect(errs.join("\n")).toContain("Usage: friday restart");

    errMock.mockRestore();
    exitMock.mockRestore();
  });

  it("errors on unknown service", () => {
    const errs: string[] = [];
    const errMock = vi.spyOn(console, "error").mockImplementation((m) => errs.push(String(m)));
    const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    expect(() => restartCommand(["bogus"])).toThrow("process.exit");
    expect(errs.join("\n")).toContain("Unknown service: bogus");

    errMock.mockRestore();
    exitMock.mockRestore();
  });
});
