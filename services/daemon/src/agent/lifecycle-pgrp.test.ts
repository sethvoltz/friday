/**
 * Integration test for M4 (process-group containment). Spawns a real
 * subprocess that backgrounds a descendant via `&; disown`, then calls
 * `killPgrp` on the pgrp leader and asserts the kernel reaped the
 * descendant — the bug here lives in whether `process.kill(-pgid, ...)`
 * actually reaches a deliberately-detached child, so we verify against
 * the real syscall, not a mock.
 */

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { killPgrp } from "./lifecycle.js";

/** kill(0) is a "does this PID exist?" probe; ESRCH means it's gone. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("M4: killPgrp reaps process-group descendants", () => {
  it("SIGTERM on the pgrp leader kills a (sleep &); disown descendant", async () => {
    // bash -c 'sleep 30 & echo $! ; disown ; sleep 30'
    // - Backgrounds a `sleep 30` directly (no subshell — `$!` would be
    //   empty in the parent shell if we used `(...)`).
    // - Prints the backgrounded PID to stdout.
    // - disowns the job so the sleep is detached from bash's job control,
    //   simulating the honest "I forgot to clean up a watcher" leak.
    // - bash itself sleeps so it stays alive as the pgrp leader.
    const child = spawn(
      "bash",
      ["-c", "sleep 30 & echo $! ; disown ; sleep 30"],
      {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    expect(child.pid).toBeGreaterThan(0);
    const pgid = child.pid!;

    // Read the backgrounded PID from bash's stdout.
    let descendantPidStr = "";
    child.stdout!.on("data", (d: Buffer) => {
      descendantPidStr += d.toString();
    });

    // Wait briefly for bash to print the backgrounded PID.
    await sleep(150);

    const descendantPid = parseInt(descendantPidStr.trim(), 10);
    expect(Number.isFinite(descendantPid)).toBe(true);
    expect(descendantPid).toBeGreaterThan(0);

    // Both alive.
    expect(pidAlive(pgid)).toBe(true);
    expect(pidAlive(descendantPid)).toBe(true);

    // Kill the pgrp via the helper under test.
    killPgrp(pgid, "SIGKILL");

    // Give the kernel a beat to reap. SIGKILL is immediate but
    // wait(2) is async at the process tree level.
    await sleep(200);

    // Both gone.
    expect(pidAlive(pgid)).toBe(false);
    expect(pidAlive(descendantPid)).toBe(false);
  });

  it("ESRCH is swallowed when pgrp is already gone", () => {
    // A pid that's almost certainly not in use. process.kill(-pid)
    // returns ESRCH; killPgrp must not throw.
    expect(() => killPgrp(999_999_999, "SIGKILL")).not.toThrow();
  });

  it("does nothing for pgid <= 1 (sanity guard)", () => {
    // We never want to send signals to pgid 0 (the calling process's
    // group) or 1 (init/launchd). The helper hard-skips these.
    expect(() => killPgrp(0, "SIGKILL")).not.toThrow();
    expect(() => killPgrp(1, "SIGKILL")).not.toThrow();
    // Also: this process itself is still alive afterward.
    expect(pidAlive(process.pid)).toBe(true);
  });
});
