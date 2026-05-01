import { execFileSync } from "node:child_process";
import {
  type ServiceName,
  SERVICES,
  isRunning,
  parseServiceArg,
} from "../services.js";
import { readState, removeState } from "../state.js";
import { hasSession, killSession } from "../tmux.js";

const SIGTERM_GRACE_MS = 5000;
const POLL_INTERVAL_MS = 100;

function sleepSync(ms: number): void {
  try {
    execFileSync("sleep", [(ms / 1000).toFixed(3)], { stdio: "ignore" });
  } catch {
    // sleep missing or interrupted — fall through; the outer poll loop
    // will simply check the pid again sooner.
  }
}

function waitForExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    sleepSync(POLL_INTERVAL_MS);
  }
  return !isRunning(pid);
}

function stopService(service: ServiceName): void {
  const info = SERVICES[service];
  const state = readState(service);

  if (!state) {
    console.log(`  ${info.label} is not running (no state file)`);
    return;
  }

  const { pid, mode, tmuxSession } = state;

  if (!isRunning(pid)) {
    console.log(`  ${info.label} is not running (stale state, PID ${pid})`);
    if (tmuxSession && hasSession(tmuxSession)) {
      killSession(tmuxSession);
    }
    removeState(service);
    return;
  }

  // SIGTERM the inner process. For dev: pnpm forwards to vite/tsx, which
  // have their own signal handlers. For prod (daemon): the daemon's
  // shutdown() handler drains agents/scheduler/event-server cleanly.
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    console.error(`  Failed to SIGTERM ${info.label} (PID ${pid}): ${err instanceof Error ? err.message : String(err)}`);
  }

  const exited = waitForExit(pid, SIGTERM_GRACE_MS);
  if (!exited) {
    console.log(`  ${info.label} did not exit after ${SIGTERM_GRACE_MS}ms — sending SIGKILL`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    waitForExit(pid, 1000);
  }

  // For dev: clear the tmux session shell (remain-on-exit leaves a [pane dead]
  // husk after the inner process exits — kill_session removes it).
  if (mode === "dev" && tmuxSession && hasSession(tmuxSession)) {
    killSession(tmuxSession);
  }

  removeState(service);
  console.log(`  ${info.label} stopped (PID ${pid})`);
}

export function stopCommand(args: string[]): void {
  const target = parseServiceArg(args[0]);
  const services: ServiceName[] = target === "all" ? ["daemon", "dashboard"] : [target];

  console.log("Stopping services...");
  for (const service of services) {
    stopService(service);
  }
}
