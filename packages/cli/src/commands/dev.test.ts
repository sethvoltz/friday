import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadPid = vi.fn().mockReturnValue(null);
const mockIsRunning = vi.fn().mockReturnValue(false);
const mockRemovePid = vi.fn();
const mockParseServiceArg = vi.fn();
const mockFindMonorepoRoot = vi.fn();

vi.mock("../services.js", () => ({
  SERVICES: {
    daemon: { label: "Friday daemon", package: "@friday/daemon", script: "start" },
    dashboard: { label: "Dashboard", package: "@friday/dashboard", script: "preview" },
  },
  readPid: (...args: any[]) => mockReadPid(...args),
  isRunning: (...args: any[]) => mockIsRunning(...args),
  removePid: (...args: any[]) => mockRemovePid(...args),
  parseServiceArg: (...args: any[]) => mockParseServiceArg(...args),
  findMonorepoRoot: () => mockFindMonorepoRoot(),
}));

const mockSpawn = vi.fn().mockReturnValue({ pid: 88 });
vi.mock("node:child_process", () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

const { devCommand } = await import("./dev.js");

describe("devCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMonorepoRoot.mockReturnValue("/fake/root");
    mockParseServiceArg.mockReturnValue("daemon");
  });

  it("requires a subcommand", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
    const mockErr = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => devCommand([])).toThrow("process.exit");

    mockExit.mockRestore();
    mockErr.mockRestore();
  });

  it("dev start spawns with dev script", () => {
    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    devCommand(["start", "daemon"]);

    expect(mockSpawn).toHaveBeenCalledWith(
      "pnpm",
      ["--filter", "@friday/daemon", "run", "dev"],
      expect.objectContaining({ cwd: "/fake/root" })
    );

    mock.mockRestore();
  });

  it("dev start all uses pnpm run dev at root", () => {
    mockParseServiceArg.mockReturnValue("all");

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    devCommand(["start"]);

    expect(mockSpawn).toHaveBeenCalledWith(
      "pnpm",
      ["run", "dev"],
      expect.objectContaining({ cwd: "/fake/root" })
    );

    mock.mockRestore();
  });

  it("rejects unknown dev subcommand", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
    const mockErr = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => devCommand(["bogus"])).toThrow("process.exit");

    mockExit.mockRestore();
    mockErr.mockRestore();
  });
});
