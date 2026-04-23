import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `friday-cli-svc-${process.pid}-${Date.now()}`);
const fridayDir = join(testDir, ".friday");

vi.mock("@friday/shared", () => ({
  FRIDAY_DIR: fridayDir,
}));

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

describe("PID file management", () => {
  beforeEach(() => {
    mkdirSync(join(fridayDir, "pids"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("writePid creates and readPid reads a PID file", () => {
    writePid("daemon", 12345);
    expect(readPid("daemon")).toBe(12345);
  });

  it("readPid returns null when no PID file exists", () => {
    expect(readPid("dashboard")).toBeNull();
  });

  it("removePid deletes the PID file", () => {
    writePid("daemon", 12345);
    removePid("daemon");
    expect(readPid("daemon")).toBeNull();
  });

  it("removePid is safe when file doesn't exist", () => {
    expect(() => removePid("daemon")).not.toThrow();
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

describe("readPid edge cases", () => {
  beforeEach(() => {
    mkdirSync(join(fridayDir, "pids"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns null for non-numeric PID file content", () => {
    writePid("daemon", 12345);
    // Overwrite with garbage
    writeFileSync(join(fridayDir, "pids", "daemon.pid"), "not-a-number");
    expect(readPid("daemon")).toBeNull();
  });
});

describe("findMonorepoRoot", () => {
  it("finds the monorepo root from within the CLI package", () => {
    const root = findMonorepoRoot();
    expect(root).not.toBeNull();
    expect(existsSync(join(root!, "pnpm-workspace.yaml"))).toBe(true);
  });
});
