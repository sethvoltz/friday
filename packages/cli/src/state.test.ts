import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testHome = join(tmpdir(), `friday-state-test-${process.pid}-${Date.now()}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

const { readState, writeState, removeState, listStates, STATE_DIR } = await import("./state.js");

describe("state", () => {
  beforeEach(() => {
    mkdirSync(testHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it("returns null when no state file exists", () => {
    expect(readState("daemon")).toBeNull();
  });

  it("round-trips a full state record", () => {
    const state = {
      pid: 12345,
      panePid: 12340,
      mode: "dev" as const,
      startedAt: "2026-05-01T15:23:11Z",
      command: ["friday", "start", "dashboard", "--dev"],
      tmuxSession: "friday-dashboard",
      logPath: "/Users/seth/.friday/logs/dashboard.jsonl",
    };
    writeState("dashboard", state);
    expect(readState("dashboard")).toEqual(state);
  });

  it("removeState deletes the file", () => {
    writeState("daemon", {
      pid: 1, mode: "prod", startedAt: "x", command: ["a"], logPath: "p",
    });
    expect(existsSync(join(STATE_DIR, "daemon.json"))).toBe(true);
    removeState("daemon");
    expect(existsSync(join(STATE_DIR, "daemon.json"))).toBe(false);
  });

  it("returns null on malformed state file rather than throwing", () => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(STATE_DIR, "daemon.json"), "{not json");
    expect(readState("daemon")).toBeNull();
  });

  it("listStates enumerates services with state files", () => {
    writeState("daemon", { pid: 1, mode: "prod", startedAt: "x", command: ["a"], logPath: "p" });
    writeState("dashboard", { pid: 2, mode: "dev", startedAt: "x", command: ["a"], logPath: "p" });
    expect(listStates().sort()).toEqual(["daemon", "dashboard"]);
  });
});
