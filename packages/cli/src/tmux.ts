import { execFileSync, spawnSync } from "node:child_process";

/**
 * Thin wrapper around the `tmux` CLI for friday's dev sessions. Each
 * service gets its own session named `friday-<svc>`. Session creation
 * sets `remain-on-exit on` so a crashed pane lingers in `[pane dead]`
 * state for post-mortem inspection.
 *
 * `hasSession` is intentionally cheap and silent (used in status checks).
 * Other operations throw on tmux errors so callers can decide whether
 * to surface the failure.
 */

function tmux(args: string[]): string {
  return execFileSync("tmux", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
}

export function hasTmuxAvailable(): boolean {
  const r = spawnSync("tmux", ["-V"], { stdio: "ignore" });
  return r.status === 0;
}

export function hasSession(name: string): boolean {
  // Use spawnSync because tmux exits 1 when the session doesn't exist —
  // execFileSync would throw and force us to catch + ignore.
  const r = spawnSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
  return r.status === 0;
}

/**
 * Create a detached tmux session running `command`. The command is passed
 * to tmux as a single string so the user's login shell evaluates it —
 * letting us use shell features like `exec` to replace the shell process
 * with the actual service (so `pane_pid` is the service, not the shell).
 */
export function newSession(name: string, command: string, cwd: string): void {
  tmux(["new-session", "-d", "-s", name, "-c", cwd, command]);
  tmux(["set-option", "-t", name, "remain-on-exit", "on"]);
}

export function killSession(name: string): void {
  if (!hasSession(name)) return;
  spawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
}

/**
 * The pane's foreground process — the immediate child of tmux. With the
 * `exec ...` invocation pattern this should already BE the service
 * process, but on macOS the user's shell may still wrap it in some cases.
 * Always cross-check with `getInnerPid` if you need the real service pid.
 */
export function getPanePid(name: string): number | null {
  if (!hasSession(name)) return null;
  try {
    const out = tmux(["list-panes", "-t", name, "-F", "#{pane_pid}"]).trim();
    const pid = parseInt(out, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * True if the pane's foreground process has exited but the pane is still
 * present (because remain-on-exit is on). Used to distinguish `crashed`
 * from `running` in status output.
 */
export function isPaneDead(name: string): boolean {
  if (!hasSession(name)) return false;
  try {
    const out = tmux(["list-panes", "-t", name, "-F", "#{pane_dead}"]).trim();
    return out === "1";
  } catch {
    return false;
  }
}

function pgrepChild(parentPid: number): number | null {
  const r = spawnSync("pgrep", ["-P", String(parentPid)], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf-8",
  });
  if (r.status !== 0) return null;
  const lines = (r.stdout ?? "").trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  const pid = parseInt(lines[0], 10);
  return isNaN(pid) ? null : pid;
}

/**
 * Walk one level of `pgrep -P` to find the immediate child of `parentPid`.
 * When `parentPid` is the pnpm-exec process we just spawned via tmux, the
 * actual vite/tsx child takes a brief moment to fork — so we poll up to
 * `timeoutMs` (default 1s, ~10 attempts) before giving up. Caller falls
 * back to `parentPid` itself if we still can't find a child; pnpm
 * forwards SIGTERM either way.
 */
export function getInnerPid(parentPid: number, timeoutMs = 1000): number | null {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const child = pgrepChild(parentPid);
    if (child !== null) return child;
    spawnSync("sleep", ["0.1"], { stdio: "ignore" });
  }
  return pgrepChild(parentPid);
}
