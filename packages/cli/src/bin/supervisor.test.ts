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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSpecs,
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

function writeFixture(scriptPath: string, pidFile: string, detachedGrandchildren = false): void {
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

/**
 * Poll until the fixture's pid file exists AND contains a complete,
 * parseable array of `expectedCount` PIDs, then return it.
 *
 * `fs.writeFileSync` is not atomic: the file can exist (created/truncated
 * to zero bytes) for an instant before the JSON payload lands. Gating on
 * `existsSync` alone races that window — under parallel load the read can
 * observe an empty or half-written file and `JSON.parse("")` throws
 * `Unexpected end of JSON input`. Waiting on the parsed shape — not just
 * the inode — closes the race deterministically. Returns null on timeout
 * so the caller's assertion can describe what it saw.
 */
async function readPidsWhenReady(
  pidFile: string,
  expectedCount: number,
  deadlineMs = 5_000,
  stepMs = 50,
): Promise<number[] | null> {
  const end = Date.now() + deadlineMs;
  let last: number[] | null = null;
  while (Date.now() < end) {
    if (existsSync(pidFile)) {
      try {
        const parsed = JSON.parse(readFileSync(pidFile, "utf8")) as number[];
        if (Array.isArray(parsed) && parsed.length === expectedCount) return parsed;
        last = Array.isArray(parsed) ? parsed : last;
      } catch {
        // Empty / partially-written file mid-`writeFileSync`; keep polling.
      }
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return last;
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

    // Wait for the fixture to fork its grandchildren and finish writing a
    // complete pid file — gating on the parsed shape, not the bare inode,
    // so we never read a zero-byte file mid-`writeFileSync`.
    const read = await readPidsWhenReady(pidFile, GRANDCHILD_COUNT + 1, 5_000);
    expect(read, "fixture pid file should hold child + N grandchildren").not.toBeNull();
    pids = read!;
    expect(pids.length).toBe(GRANDCHILD_COUNT + 1); // child + N grandchildren
    expect(pids[0]).toBe(proc.pid);

    // Sanity: every pid should be alive right now.
    for (const pid of pids) {
      expect(isAlive(pid), `pre-condition: pid ${pid} should be alive`).toBe(true);
    }

    // Build a ChildState shell — killChildGroup only reads `proc.pid`
    // and `spec.name`. The rest is irrelevant to this call.
    const state: ChildState = {
      spec: { name: "daemon" } as any,
      proc,
      exitTimestamps: [],
      backoffMs: 0,
      shuttingDown: true,
    };

    // The load-bearing call.
    killChildGroup(state, "SIGTERM");

    // SIGTERM is delivered async. Give the kernel a moment to reap.
    const allDead = await waitFor(() => pids.every((pid) => !isAlive(pid)), 5_000);
    if (!allDead) {
      const stillAlive = pids.filter((pid) => isAlive(pid));
      throw new Error(`cascade-stop incomplete: pids still alive: ${stillAlive.join(", ")}`);
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
    const read = await readPidsWhenReady(pidFile, GRANDCHILD_COUNT + 1, 5_000);
    expect(read, "fixture pid file should hold child + N grandchildren").not.toBeNull();
    pids = read!;
    expect(pids.length).toBe(GRANDCHILD_COUNT + 1);

    // Pre-condition: all alive.
    for (const pid of pids) {
      expect(isAlive(pid), `pre: pid ${pid} should be alive`).toBe(true);
    }

    const state: ChildState = {
      spec: { name: "zero-cache" } as any,
      proc,
      exitTimestamps: [],
      backoffMs: 0,
      shuttingDown: true,
    };

    killChildGroup(state, "SIGTERM");

    const allDead = await waitFor(() => pids.every((pid) => !isAlive(pid)), 5_000);
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

// ---- zero-cache child-spec env --------------------------------------

describe("buildSpecs — zero-cache env", () => {
  /**
   * The zero-cache spec must default `ZERO_NUM_SYNC_WORKERS` to "2". Left
   * unset, zero-cache auto-sizes its sync-worker pool to ~1-per-core
   * (`availableParallelism() - 1`); on a 10-core host that's 9 workers
   * holding ~5 Postgres connections each (~42 total) for a single-user
   * box. Pinning to 2 keeps realtime sync parallelism while cutting
   * connection count ~65%.
   *
   * The default is placed BEFORE the `...process.env` spread in the spec's
   * env, so a user's `ZERO_NUM_SYNC_WORKERS` in `~/.friday/.env` (loaded
   * into `process.env`) overrides it — system-default-in-code,
   * .env-override-only. The two tests below pin both halves of that
   * contract: default "2" when unset, and the user's "4" when set.
   *
   * buildSpecs reads only config (defaults under the test tmpdir), so it
   * runs in isolation with no subprocesses.
   */
  it("defaults ZERO_NUM_SYNC_WORKERS to 2 on the zero-cache spec when ambient env is unset", () => {
    // The default lives before the process.env spread; clear any ambient
    // value so the assertion exercises the default, not an inherited one.
    const prior = process.env.ZERO_NUM_SYNC_WORKERS;
    delete process.env.ZERO_NUM_SYNC_WORKERS;
    try {
      const specs = buildSpecs("/tmp/friday-repo-root-fixture");
      const zero = specs.find((s) => s.name === "zero-cache");
      expect(zero, "zero-cache spec should exist").toBeDefined();
      expect(zero!.env.ZERO_NUM_SYNC_WORKERS).toBe("2");
    } finally {
      if (prior !== undefined) process.env.ZERO_NUM_SYNC_WORKERS = prior;
    }
  });

  it("lets a user's ZERO_NUM_SYNC_WORKERS override the default (user value wins)", () => {
    // `~/.friday/.env` is loaded into process.env before buildSpecs runs.
    // Because the "2" default is placed BEFORE the `...process.env` spread,
    // a user-supplied value must win. Pin "4" and assert it survives.
    const prior = process.env.ZERO_NUM_SYNC_WORKERS;
    process.env.ZERO_NUM_SYNC_WORKERS = "4";
    try {
      const specs = buildSpecs("/tmp/friday-repo-root-fixture");
      const zero = specs.find((s) => s.name === "zero-cache");
      expect(zero, "zero-cache spec should exist").toBeDefined();
      expect(zero!.env.ZERO_NUM_SYNC_WORKERS).toBe("4");
    } finally {
      if (prior === undefined) delete process.env.ZERO_NUM_SYNC_WORKERS;
      else process.env.ZERO_NUM_SYNC_WORKERS = prior;
    }
  });

  it("defaults ZERO_APP_PUBLICATIONS to friday_pub on the zero-cache spec when ambient env is unset", () => {
    // The publication name moved from a `friday setup`-written `.env` entry
    // to a code default on the zero-cache spec, placed BEFORE the
    // `...process.env` spread. zero-cache must target Friday's
    // logical-replication publication; "friday_pub" is the name created by
    // `ensurePublication` in pg-provision. Clear any ambient value so the
    // assertion exercises the default, not an inherited one.
    const prior = process.env.ZERO_APP_PUBLICATIONS;
    delete process.env.ZERO_APP_PUBLICATIONS;
    try {
      const specs = buildSpecs("/tmp/friday-repo-root-fixture");
      const zero = specs.find((s) => s.name === "zero-cache");
      expect(zero, "zero-cache spec should exist").toBeDefined();
      expect(zero!.env.ZERO_APP_PUBLICATIONS).toBe("friday_pub");
    } finally {
      if (prior !== undefined) process.env.ZERO_APP_PUBLICATIONS = prior;
    }
  });

  it("lets a user's ZERO_APP_PUBLICATIONS override the default (user value wins)", () => {
    // Because the default is placed BEFORE the `...process.env` spread, a
    // value loaded from `~/.friday/.env` into process.env must win.
    const prior = process.env.ZERO_APP_PUBLICATIONS;
    process.env.ZERO_APP_PUBLICATIONS = "custom_pub";
    try {
      const specs = buildSpecs("/tmp/friday-repo-root-fixture");
      const zero = specs.find((s) => s.name === "zero-cache");
      expect(zero, "zero-cache spec should exist").toBeDefined();
      expect(zero!.env.ZERO_APP_PUBLICATIONS).toBe("custom_pub");
    } finally {
      if (prior === undefined) delete process.env.ZERO_APP_PUBLICATIONS;
      else process.env.ZERO_APP_PUBLICATIONS = prior;
    }
  });

  /**
   * The zero-cache spec must also default the cluster-wide syncer-connection
   * caps `ZERO_UPSTREAM_MAX_CONNS` ("4") and `ZERO_CVR_MAX_CONNS` ("6"). These
   * are the real lever for total connection count — zero-cache divides each cap
   * evenly across sync workers — distinct from the worker count itself. With
   * ZERO_NUM_SYNC_WORKERS=2 they divide to ~2 upstream + ~3 CVR per worker; the
   * per-worker floor must stay ≥ the worker count or zero-cache throws at
   * startup, so 4 and 6 are the safe minimum for 2 workers. Both defaults sit
   * BEFORE the `...process.env` spread, so a user's `~/.friday/.env` value wins.
   * The four tests below pin both halves of that contract for each var.
   */
  it("defaults ZERO_UPSTREAM_MAX_CONNS to 4 on the zero-cache spec when ambient env is unset", () => {
    // The default lives before the process.env spread; clear any ambient
    // value so the assertion exercises the default, not an inherited one.
    const prior = process.env.ZERO_UPSTREAM_MAX_CONNS;
    delete process.env.ZERO_UPSTREAM_MAX_CONNS;
    try {
      const specs = buildSpecs("/tmp/friday-repo-root-fixture");
      const zero = specs.find((s) => s.name === "zero-cache");
      expect(zero, "zero-cache spec should exist").toBeDefined();
      expect(zero!.env.ZERO_UPSTREAM_MAX_CONNS).toBe("4");
    } finally {
      if (prior !== undefined) process.env.ZERO_UPSTREAM_MAX_CONNS = prior;
    }
  });

  it("lets a user's ZERO_UPSTREAM_MAX_CONNS override the default (user value wins)", () => {
    // `~/.friday/.env` is loaded into process.env before buildSpecs runs.
    // Because the "4" default is placed BEFORE the `...process.env` spread,
    // a user-supplied value must win. Pin "8" and assert it survives.
    const prior = process.env.ZERO_UPSTREAM_MAX_CONNS;
    process.env.ZERO_UPSTREAM_MAX_CONNS = "8";
    try {
      const specs = buildSpecs("/tmp/friday-repo-root-fixture");
      const zero = specs.find((s) => s.name === "zero-cache");
      expect(zero, "zero-cache spec should exist").toBeDefined();
      expect(zero!.env.ZERO_UPSTREAM_MAX_CONNS).toBe("8");
    } finally {
      if (prior === undefined) delete process.env.ZERO_UPSTREAM_MAX_CONNS;
      else process.env.ZERO_UPSTREAM_MAX_CONNS = prior;
    }
  });

  it("defaults ZERO_CVR_MAX_CONNS to 6 on the zero-cache spec when ambient env is unset", () => {
    // The default lives before the process.env spread; clear any ambient
    // value so the assertion exercises the default, not an inherited one.
    const prior = process.env.ZERO_CVR_MAX_CONNS;
    delete process.env.ZERO_CVR_MAX_CONNS;
    try {
      const specs = buildSpecs("/tmp/friday-repo-root-fixture");
      const zero = specs.find((s) => s.name === "zero-cache");
      expect(zero, "zero-cache spec should exist").toBeDefined();
      expect(zero!.env.ZERO_CVR_MAX_CONNS).toBe("6");
    } finally {
      if (prior !== undefined) process.env.ZERO_CVR_MAX_CONNS = prior;
    }
  });

  it("lets a user's ZERO_CVR_MAX_CONNS override the default (user value wins)", () => {
    // `~/.friday/.env` is loaded into process.env before buildSpecs runs.
    // Because the "6" default is placed BEFORE the `...process.env` spread,
    // a user-supplied value must win. Pin "12" and assert it survives.
    const prior = process.env.ZERO_CVR_MAX_CONNS;
    process.env.ZERO_CVR_MAX_CONNS = "12";
    try {
      const specs = buildSpecs("/tmp/friday-repo-root-fixture");
      const zero = specs.find((s) => s.name === "zero-cache");
      expect(zero, "zero-cache spec should exist").toBeDefined();
      expect(zero!.env.ZERO_CVR_MAX_CONNS).toBe("12");
    } finally {
      if (prior === undefined) delete process.env.ZERO_CVR_MAX_CONNS;
      else process.env.ZERO_CVR_MAX_CONNS = prior;
    }
  });

  it("does not pin ZERO_NUM_SYNC_WORKERS on the daemon or dashboard specs", () => {
    // The sync-worker cap is zero-cache-specific; it must not leak onto
    // the other children's env. Both specs spread `process.env`, so clear
    // any ambient value first to keep the negative assertion robust.
    const prior = process.env.ZERO_NUM_SYNC_WORKERS;
    delete process.env.ZERO_NUM_SYNC_WORKERS;
    try {
      const specs = buildSpecs("/tmp/friday-repo-root-fixture");
      for (const name of ["daemon", "dashboard"] as const) {
        const spec = specs.find((s) => s.name === name);
        expect(spec, `${name} spec should exist`).toBeDefined();
        expect(spec!.env.ZERO_NUM_SYNC_WORKERS).toBeUndefined();
      }
    } finally {
      if (prior !== undefined) process.env.ZERO_NUM_SYNC_WORKERS = prior;
    }
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
    const recent = [now - 50_000, now - 40_000, now - 30_000, now - 20_000, now - 10_000];
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
