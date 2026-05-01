import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testHome = join(tmpdir(), `friday-cli-svc-${process.pid}-${Date.now()}`);
const fridayDir = join(testHome, ".friday");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

const { readPid, writePid, removePid, isRunning, parseServiceArg, SERVICES, findMonorepoRoot } =
  await import("./services.js");

describe("SERVICES registry", () => {
  it("defines daemon and dashboard", () => {
    expect(SERVICES.daemon).toBeDefined();
    expect(SERVICES.dashboard).toBeDefined();
    expect(SERVICES.daemon.label).toBe("Friday daemon");
    expect(SERVICES.dashboard.label).toBe("Dashboard");
  });
});

describe("PID accessors (state-backed)", () => {
  beforeEach(() => {
    mkdirSync(fridayDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it("writePid creates and readPid reads back the pid", () => {
    writePid("daemon", 12345);
    expect(readPid("daemon")).toBe(12345);
  });

  it("readPid returns null when no state file exists", () => {
    expect(readPid("dashboard")).toBeNull();
  });

  it("removePid deletes the state file", () => {
    writePid("daemon", 12345);
    removePid("daemon");
    expect(readPid("daemon")).toBeNull();
  });

  it("removePid is safe when file doesn't exist", () => {
    expect(() => removePid("daemon")).not.toThrow();
  });

  it("writePid synthesizes a default state record (mode prod) on first write", () => {
    writePid("daemon", 12345);
    const state = JSON.parse(
      readFileSync(join(fridayDir, "state", "daemon.json"), "utf-8")
    );
    expect(state.pid).toBe(12345);
    expect(state.mode).toBe("prod");
    expect(state.command).toEqual(["friday", "start", "daemon"]);
    expect(state.logPath).toBe(join(fridayDir, "logs", "daemon.jsonl"));
  });

  it("readPid returns null when state JSON is malformed", () => {
    mkdirSync(join(fridayDir, "state"), { recursive: true });
    writeFileSync(join(fridayDir, "state", "daemon.json"), "{not valid json");
    expect(readPid("daemon")).toBeNull();
  });
});

describe("isRunning", () => {
  it("returns true for current process", () => {
    expect(isRunning(process.pid)).toBe(true);
  });

  it("returns false for unlikely PID", () => {
    expect(isRunning(999999999)).toBe(false);
  });
});

describe("parseServiceArg", () => {
  it("returns 'all' for undefined", () => {
    expect(parseServiceArg(undefined)).toBe("all");
  });

  it("returns 'all' for 'all'", () => {
    expect(parseServiceArg("all")).toBe("all");
  });

  it("returns service name for valid service", () => {
    expect(parseServiceArg("daemon")).toBe("daemon");
    expect(parseServiceArg("dashboard")).toBe("dashboard");
  });

  it("exits for unknown service", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
    const mockErr = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => parseServiceArg("bogus")).toThrow("process.exit");
    mockExit.mockRestore();
    mockErr.mockRestore();
  });
});

describe("findMonorepoRoot", () => {
  it("finds the monorepo root from within the CLI package", () => {
    const root = findMonorepoRoot();
    expect(root).not.toBeNull();
    expect(existsSync(join(root!, "pnpm-workspace.yaml"))).toBe(true);
  });
});
