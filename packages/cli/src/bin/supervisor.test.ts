/**
 * Pin the load-bearing cascade-stop semantics of `friday-supervisor`.
 *
 * The FRI-83 zombie pattern (tmux `kill-session` leaves grandchild
 * workers alive) is what this binary exists to prevent. The
 * single-most-important assertion is: when the supervisor's
 * `killChildGroup` sends SIGTERM to a child's process group, every
 * descendant in that group dies — not just the direct child.
 *
 * The test uses a real subprocess tree, not mocks: a fixture script
 * forks N grandchildren under the same process group as the child
 * itself; the test signals the group and verifies every PID is dead.
 * The crash-loop guard's state machine is exercised in isolation —
 * pure data, no subprocess required.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CRASH_LOOP_MAX,
  CRASH_LOOP_WINDOW_MS,
  killChildGroup,
  type ChildState,
} from "./supervisor.js";

// ---- fixture --------------------------------------------------------

/**
 * Fixture script. Forks `GRANDCHILD_COUNT` grandchildren (each a
 * `sleep 99999` subprocess inheriting our pgid), writes every alive PID
 * — its own plus the grandchildren — to a known file, then idles. SIGTERM
 * is handled by Node's default (clean exit), and the grandchildren die
 * via the process-group signal the test sends.
 *
 * The fixture is the SAME shape of process tree zero-cache produces in
 * prod (multi-worker pool). If `killChildGroup` doesn't catch this, it
 * won't catch zero-cache either.
 */
const GRANDCHILD_COUNT = 3;

function writeFixture(
  scriptPath: string,
  pidFile: string,
  detachedGrandchildren = false,
): void {
  // `detached: true` on the grandchildren makes each one its own
  // pgid leader — the zero-cache pattern that defeats process-group
  // signaling and motivates the supervisor's tree-walk approach.
  const detachOpt = detachedGrandchildren ? "true" : "false";
  const unref = detachedGrandchildren ? "c.unref();" : "";
  const src = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const pids = [process.pid];
for (let i = 0; i < ${GRANDCHILD_COUNT}; i++) {
  const c = spawn("sleep", ["99999"], { stdio: "ignore", detached: ${detachOpt} });
  ${unref}
  pids.push(c.pid);
}
fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(pids));
// Idle until SIGTERM. The default Node handler exits clean.
setInterval(() => {}, 60000);
`;
  writeFileSync(scriptPath, src);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM means alive but we can't signal it — for our test fixtures
    // (same uid) this won't happen, but treat as alive defensively.
    return true;
  }
}

async function waitFor(pred: () => boolean, deadlineMs: number, stepMs = 50): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}

// ---- cascade-stop end-to-end ----------------------------------------

describe("killChildGroup — cascade SIGTERM to a child's process group", () => {
  let tmpDir: string;
  let proc: ChildProcess | null = null;
  let pids: number[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "friday-supervisor-test-"));
  });

  afterEach(async () => {
    // Defensive: if the test failed before killChildGroup ran, the
    // fixture's process tree could still be alive. Reap it.
    if (proc && proc.pid && isAlive(proc.pid)) {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        // best-effort
      }
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // best-effort
      }
    }
    proc = null;
    pids = [];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("kills the child plus every grandchild in the same process group", async () => {
    const scriptPath = join(tmpDir, "fixture.js");
    const pidFile = join(tmpDir, "pids.json");
    writeFixture(scriptPath, pidFile);

    // Spawn with `detached: true` so the fixture becomes its own
    // process-group leader (pid == pgid). This is exactly how the
    // supervisor spawns daemon/dashboard/zero-cache in prod.
    proc = spawn("node", [scriptPath], {
      stdio: "ignore",
      detached: true,
    });

    // Wait for the fixture to fork its grandchildren and write the pid file.
    const wrote = await waitFor(() => existsSync(pidFile), 5_000);
    expect(wrote).toBe(true);
    pids = JSON.parse(readFileSync(pidFile, "utf8")) as number[];
    expect(pids.length).toBe(GRANDCHILD_COUNT + 1); // child + N grandchildren
    expect(pids[0]).toBe(proc.pid);

    // Sanity: every pid should be alive right now.
    for (const pid of pids) {
      expect(isAlive(pid), `pre-condition: pid ${pid} should be alive`).toBe(true);
    }

    // Build a ChildState shell — killChildGroup only reads `proc.pid`
    // and `spec.name`. The rest is irrelevant to this call.
    const state: ChildState = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: { name: "daemon" } as any,
      proc,
      exitTimestamps: [],
      backoffMs: 0,
      shuttingDown: true,
    };

    // The load-bearing call.
    killChildGroup(state, "SIGTERM");

    // SIGTERM is delivered async. Give the kernel a moment to reap.
    const allDead = await waitFor(
      () => pids.every((pid) => !isAlive(pid)),
      5_000,
    );
    if (!allDead) {
      const stillAlive = pids.filter((pid) => isAlive(pid));
      throw new Error(
        `cascade-stop incomplete: pids still alive: ${stillAlive.join(", ")}`,
      );
    }
    // Explicit assertion so the test name's promise load-bears.
    for (const pid of pids) {
      expect(isAlive(pid), `post: pid ${pid} should be dead`).toBe(false);
    }
  });

  it("catches grandchildren that set their own pgid (the zero-cache setsid pattern)", async () => {
    // Spawn grandchildren with `detached: true` so each is its own
    // pgid leader. A naive `kill -<child.pgid>` would miss them
    // (they're in different pgids); only the tree-walk via
    // `pgrep -P` catches them. This is the exact failure mode
    // surfaced during the FRI-88 operator flip.
    const scriptPath = join(tmpDir, "fixture-detached.js");
    const pidFile = join(tmpDir, "pids-detached.json");
    writeFixture(scriptPath, pidFile, /* detachedGrandchildren */ true);

    proc = spawn("node", [scriptPath], {
      stdio: "ignore",
      detached: true,
    });
    const wrote = await waitFor(() => existsSync(pidFile), 5_000);
    expect(wrote).toBe(true);
    pids = JSON.parse(readFileSync(pidFile, "utf8")) as number[];
    expect(pids.length).toBe(GRANDCHILD_COUNT + 1);

    // Pre-condition: all alive.
    for (const pid of pids) {
      expect(isAlive(pid), `pre: pid ${pid} should be alive`).toBe(true);
    }

    const state: ChildState = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: { name: "zero-cache" } as any,
      proc,
      exitTimestamps: [],
      backoffMs: 0,
      shuttingDown: true,
    };

    killChildGroup(state, "SIGTERM");

    const allDead = await waitFor(
      () => pids.every((pid) => !isAlive(pid)),
      5_000,
    );
    if (!allDead) {
      const stillAlive = pids.filter((pid) => isAlive(pid));
      throw new Error(
        `cascade-stop incomplete for setsid grandchildren: pids still alive: ${stillAlive.join(", ")}`,
      );
    }
    for (const pid of pids) {
      expect(isAlive(pid), `post: pid ${pid} should be dead`).toBe(false);
    }
  });

  it("is idempotent — calling killChildGroup on an already-dead group is a no-op", async () => {
    // Spawn a fixture that exits immediately so its group is gone
    // before we signal.
    const scriptPath = join(tmpDir, "short-fixture.js");
    writeFileSync(scriptPath, `process.exit(0);`);
    proc = spawn("node", [scriptPath], { stdio: "ignore", detached: true });

    // Wait for it to exit.
    await new Promise<void>((resolve) => proc!.on("exit", () => resolve()));

    const state: ChildState = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: { name: "daemon" } as any,
      proc,
      exitTimestamps: [],
      backoffMs: 0,
      shuttingDown: true,
    };

    // Should not throw; ESRCH from the kernel is swallowed by the helper.
    expect(() => killChildGroup(state, "SIGTERM")).not.toThrow();
  });
});

// ---- crash-loop window arithmetic -----------------------------------

describe("crash-loop guard arithmetic", () => {
  /**
   * The crash-loop guard fires when `exitTimestamps.length >=
   * CRASH_LOOP_MAX` after pruning to the `CRASH_LOOP_WINDOW_MS` window.
   * This test exercises the trimming logic by walking timestamps and
   * checking the conditions the supervisor's exit handler relies on.
   *
   * No subprocesses — pure data, fast, reliable.
   */
  function pruneToWindow(timestamps: number[], now: number): number[] {
    const cutoff = now - CRASH_LOOP_WINDOW_MS;
    return timestamps.filter((t) => t > cutoff);
  }

  it("retains crashes within the window", () => {
    const now = Date.now();
    const recent = [
      now - 50_000,
      now - 40_000,
      now - 30_000,
      now - 20_000,
      now - 10_000,
    ];
    const pruned = pruneToWindow(recent, now);
    expect(pruned.length).toBe(5);
    expect(pruned.length >= CRASH_LOOP_MAX).toBe(true);
  });

  it("drops crashes older than the window", () => {
    const now = Date.now();
    const mixed = [
      now - 120_000, // outside the 60s window
      now - 90_000, // outside
      now - 30_000, // inside
      now - 20_000, // inside
      now - 10_000, // inside
    ];
    const pruned = pruneToWindow(mixed, now);
    expect(pruned.length).toBe(3);
    expect(pruned.length >= CRASH_LOOP_MAX).toBe(false);
  });

  it("CRASH_LOOP_MAX is high enough to absorb a normal AutoResetSignal cycle", () => {
    // zero-cache exit code 14 is treated as fast-restart with no
    // backoff. A schema migration could legitimately trigger one or
    // two resets in a row. If MAX were 2-3, the supervisor would
    // crash-loop-exit on a healthy migration. 5 is the safety margin.
    expect(CRASH_LOOP_MAX).toBeGreaterThanOrEqual(5);
  });

  it("CRASH_LOOP_WINDOW_MS is wide enough to catch a real loop, narrow enough to forgive transients", () => {
    // 60s is the documented window. < 30s would fail to catch a slow
    // crash loop (e.g. one failure every 10s). > 5min would
    // false-positive on legitimate scattered transients.
    expect(CRASH_LOOP_WINDOW_MS).toBeGreaterThanOrEqual(30_000);
    expect(CRASH_LOOP_WINDOW_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});
