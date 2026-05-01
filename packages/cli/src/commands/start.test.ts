import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadState = vi.fn().mockReturnValue(null);
const mockIsRunning = vi.fn().mockReturnValue(false);
const mockFindMonorepoRoot = vi.fn().mockReturnValue("/fake/root");
const mockParseServiceArg = vi.fn().mockReturnValue("daemon");
const mockLaunchProd = vi.fn().mockReturnValue(42);
const mockLaunchDev = vi.fn().mockReturnValue({ innerPid: 7001, sessionName: "friday-dashboard" });

vi.mock("../services.js", () => ({
  SERVICES: {
    daemon: { label: "Friday daemon" },
    dashboard: { label: "Dashboard" },
  },
  isRunning: (...args: any[]) => mockIsRunning(...args),
  findMonorepoRoot: () => mockFindMonorepoRoot(),
  parseServiceArg: (...args: any[]) => mockParseServiceArg(...args),
}));

vi.mock("../state.js", () => ({
  readState: (...args: any[]) => mockReadState(...args),
}));

vi.mock("../launch.js", () => ({
  launchProd: (...args: any[]) => mockLaunchProd(...args),
  launchDev: (...args: any[]) => mockLaunchDev(...args),
}));

const { startCommand } = await import("./start.js");

describe("startCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMonorepoRoot.mockReturnValue("/fake/root");
    mockParseServiceArg.mockReturnValue("daemon");
    mockReadState.mockReturnValue(null);
  });

  it("starts a service in prod mode by default", () => {
    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    startCommand(["daemon"]);

    expect(mockLaunchProd).toHaveBeenCalledWith("daemon", "/fake/root");
    expect(logs.join("\n")).toContain("started in prod mode (PID 42)");

    mock.mockRestore();
  });

  it("starts a service in dev mode with --dev flag", () => {
    mockParseServiceArg.mockReturnValue("dashboard");
    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    startCommand(["dashboard", "--dev"]);

    expect(mockLaunchDev).toHaveBeenCalledWith("dashboard", "/fake/root");
    expect(logs.join("\n")).toContain("started in dev mode");

    mock.mockRestore();
  });

  it("errors with conflict message when already running in prod", () => {
    mockReadState.mockReturnValue({
      pid: 999, mode: "prod", startedAt: "x", command: ["a"], logPath: "p",
    });
    mockIsRunning.mockReturnValue(true);

    const errs: string[] = [];
    const errMock = vi.spyOn(console, "error").mockImplementation((m) => errs.push(String(m)));
    const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    expect(() => startCommand(["daemon"])).toThrow("process.exit");
    expect(errs.join("\n")).toContain("already running in prod mode (PID 999)");
    expect(errs.join("\n")).toContain("friday stop daemon && friday start daemon --dev");

    errMock.mockRestore();
    exitMock.mockRestore();
  });

  it("errors with conflict message when already running in dev", () => {
    mockReadState.mockReturnValue({
      pid: 7001, mode: "dev", startedAt: "x", command: ["a"], logPath: "p",
      tmuxSession: "friday-daemon",
    });
    mockIsRunning.mockReturnValue(true);

    const errs: string[] = [];
    const errMock = vi.spyOn(console, "error").mockImplementation((m) => errs.push(String(m)));
    const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    expect(() => startCommand(["daemon", "--dev"])).toThrow("process.exit");
    expect(errs.join("\n")).toContain("already running in dev mode (PID 7001)");
    expect(errs.join("\n")).toContain("friday stop daemon && friday start daemon");

    errMock.mockRestore();
    exitMock.mockRestore();
  });

  it("exits when monorepo root not found", () => {
    mockFindMonorepoRoot.mockReturnValue(null);
    const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
    const errMock = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => startCommand(["daemon"])).toThrow("process.exit");

    exitMock.mockRestore();
    errMock.mockRestore();
  });

  it("recovers from stale state (pid dead) by launching fresh", () => {
    mockParseServiceArg.mockReturnValue("dashboard");
    mockReadState.mockReturnValue({
      pid: 99999, mode: "dev", tmuxSession: "friday-dashboard",
      startedAt: "x", command: ["a"], logPath: "p",
    });
    mockIsRunning.mockReturnValue(false); // stale: state file lingers, process gone

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    startCommand(["dashboard", "--dev"]);

    // No conflict error — we fell through to launchDev despite the stale state file
    expect(mockLaunchDev).toHaveBeenCalledWith("dashboard", "/fake/root");
    expect(logs.join("\n")).toContain("started in dev mode");

    mock.mockRestore();
  });

  it("surfaces launch errors to the user (e.g. stale dist)", () => {
    mockLaunchProd.mockImplementationOnce(() => {
      throw new Error("friday: build required: pnpm --filter @friday/daemon build");
    });
    const errs: string[] = [];
    const errMock = vi.spyOn(console, "error").mockImplementation((m) => errs.push(String(m)));
    const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    expect(() => startCommand(["daemon"])).toThrow("process.exit");
    expect(errs.join("\n")).toContain("friday: build required:");

    errMock.mockRestore();
    exitMock.mockRestore();
  });
});
