import { spawn } from "node:child_process";

/**
 * Liveness check for a pid: signal 0 doesn't deliver, but errors when the
 * process is gone (or owned by another user). Treat any error as "not
 * running"; the only realistic failure here is ESRCH (no such process).
 */
export function isAlive(pid: number | undefined | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a long-lived background process detached from the parent. Stdio is
 * fully ignored; the child is responsible for redirecting its own output
 * (e.g. cloudflared's `--logfile` flag).
 *
 * Returns the child's pid. Caller persists it to state for later
 * supervision (`isAlive`, `process.kill`).
 */
export function spawnDetached(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): number {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: "ignore",
  });
  if (typeof child.pid !== "number") {
    throw new Error(`failed to spawn ${command} (no pid)`);
  }
  child.unref();
  return child.pid;
}

/**
 * Send SIGTERM to a pid and wait briefly for it to exit. Returns true if
 * the process is gone by the deadline. Falls back to SIGKILL if it isn't.
 */
export async function stopPid(
  pid: number,
  { timeoutMs = 3000 }: { timeoutMs?: number } = {},
): Promise<boolean> {
  if (!isAlive(pid)) return true;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return true; // already gone
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
  return !isAlive(pid);
}
