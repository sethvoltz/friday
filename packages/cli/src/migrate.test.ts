import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testHome = join(tmpdir(), `friday-migrate-test-${process.pid}-${Date.now()}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

// Stub child_process so we can simulate the four cases:
//   - PID maps to a friday process (cmd contains @friday/<pkg>)
//   - PID was recycled to an unrelated process
//   - PID is gone (`ps` exits non-zero)
const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (cmd: string, opts: any) => mockExecSync(cmd, opts),
}));

const { migratePidsToState } = await import("./migrate.js");
const { readState } = await import("./state.js");

const fridayDir = join(testHome, ".friday");
const legacyPidsDir = join(fridayDir, "pids");
const stateDir = join(fridayDir, "state");

function writeLegacyPid(service: string, pid: number): void {
  mkdirSync(legacyPidsDir, { recursive: true });
  writeFileSync(join(legacyPidsDir, `${service}.pid`), String(pid));
}

describe("migratePidsToState", () => {
  beforeEach(() => {
    mkdirSync(fridayDir, { recursive: true });
    mockExecSync.mockReset();
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it("is a no-op when no legacy pids dir exists", () => {
    migratePidsToState();
    expect(existsSync(stateDir)).toBe(false);
  });

  it("promotes a live friday PID to a state record", () => {
    writeLegacyPid("daemon", 4242);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("-o command=")) {
        return Buffer.from("node services/friday/dist/index.js");
      }
      if (cmd.includes("-o lstart=")) {
        return Buffer.from("Thu May  1 13:32:17 2026");
      }
      return Buffer.from("");
    });

    migratePidsToState();

    const state = readState("daemon");
    expect(state).not.toBeNull();
    expect(state!.pid).toBe(4242);
    expect(state!.mode).toBe("prod");
    expect(state!.command).toEqual(["friday", "start", "daemon"]);
    // Legacy file is consumed
    expect(existsSync(join(legacyPidsDir, "daemon.pid"))).toBe(false);
  });

  it("drops a stale PID (process gone)", () => {
    writeLegacyPid("daemon", 99999);
    mockExecSync.mockImplementation(() => {
      throw new Error("ps -p exited non-zero");
    });

    migratePidsToState();

    expect(readState("daemon")).toBeNull();
    expect(existsSync(join(legacyPidsDir, "daemon.pid"))).toBe(false);
  });

  it("drops a recycled PID (cmd doesn't match a friday process)", () => {
    writeLegacyPid("dashboard", 5555);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("-o command=")) {
        return Buffer.from("/usr/bin/sshd -D");
      }
      return Buffer.from("");
    });

    migratePidsToState();

    expect(readState("dashboard")).toBeNull();
    expect(existsSync(join(legacyPidsDir, "dashboard.pid"))).toBe(false);
  });

  it("removes the legacy pids dir when fully drained", () => {
    writeLegacyPid("daemon", 1);
    writeLegacyPid("dashboard", 2);
    mockExecSync.mockImplementation(() => { throw new Error("ps gone"); });

    migratePidsToState();

    expect(existsSync(legacyPidsDir)).toBe(false);
  });

  it("preserves an existing state file rather than overwriting it", () => {
    writeLegacyPid("daemon", 1234);
    // Pre-existing state from a newer code path
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "daemon.json"),
      JSON.stringify({
        pid: 9999, mode: "dev", startedAt: "2026-05-01T00:00:00Z",
        command: ["friday", "start", "daemon", "--dev"],
        tmuxSession: "friday-daemon",
        logPath: "/x/y.jsonl",
      })
    );
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("-o command=")) return Buffer.from("node services/friday/dist/index.js");
      if (cmd.includes("-o lstart=")) return Buffer.from("Thu May  1 13:32:17 2026");
      return Buffer.from("");
    });

    migratePidsToState();

    const state = readState("daemon");
    expect(state!.pid).toBe(9999); // unchanged from pre-existing
    expect(state!.mode).toBe("dev"); // unchanged from pre-existing
  });

  it("ignores non-.pid files in the legacy dir", () => {
    mkdirSync(legacyPidsDir, { recursive: true });
    writeFileSync(join(legacyPidsDir, "README.txt"), "noise");
    writeLegacyPid("daemon", 1);
    mockExecSync.mockImplementation(() => { throw new Error("ps gone"); });

    migratePidsToState();

    // README still there → dir not removed (correct: don't touch unknown files)
    expect(readdirSync(legacyPidsDir)).toEqual(["README.txt"]);
  });
});
