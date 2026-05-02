import { execFileSync } from "node:child_process";
import { defineCommand } from "citty";
import {
  type ServiceName,
  SERVICES,
  isRunning,
  findMonorepoRoot,
} from "../services.js";
import { readState, removeState, type ServiceState } from "../state.js";
import { hasSession, killSession } from "../tmux.js";
import { launchProd, launchDev } from "../launch.js";

const SIGTERM_GRACE_MS = 5000;
const POLL_INTERVAL_MS = 100;

function sleepSync(ms: number): void {
  try {
    execFileSync("sleep", [(ms / 1000).toFixed(3)], { stdio: "ignore" });
  } catch {
    /* fall through */
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

function killService(state: ServiceState): void {
  if (isRunning(state.pid)) {
    try { process.kill(state.pid, "SIGTERM"); } catch { /* gone */ }
    if (!waitForExit(state.pid, SIGTERM_GRACE_MS)) {
      try { process.kill(state.pid, "SIGKILL"); } catch { /* ignore */ }
      waitForExit(state.pid, 1000);
    }
  }
  if (state.mode === "dev" && state.tmuxSession && hasSession(state.tmuxSession)) {
    killSession(state.tmuxSession);
  }
}

function rejectModeFlags(args: string[]): void {
  for (const a of args) {
    if (a === "--dev" || a === "--prod") {
      console.error(
        `restart does not accept ${a}. Restart preserves the current mode.\n` +
        `To switch modes: friday stop <service> && friday start <service>${a === "--dev" ? " --dev" : ""}`
      );
      process.exit(1);
    }
  }
}

export const restartCommandCitty = defineCommand({
  meta: {
    name: "restart",
    description:
      "Restart a service (daemon or dashboard). Preserves the current mode — does not accept --dev/--prod.",
  },
  args: {
    service: {
      type: "positional",
      required: true,
      description: "daemon | dashboard",
    },
  },
  run({ args, rawArgs }) {
    const argv: string[] = [];
    if (typeof args.service === "string") argv.push(args.service);
    // Preserve mode-flag rejection: forward any --dev/--prod the user typed.
    for (const a of rawArgs) {
      if (a === "--dev" || a === "--prod") argv.push(a);
    }
    restartCommand(argv);
  },
});

export function restartCommand(args: string[]): void {
  rejectModeFlags(args);

  const serviceName = args[0];
  if (!serviceName) {
    console.error("Usage: friday restart <service>");
    console.error("A service name is required: daemon or dashboard");
    process.exit(1);
  }

  if (serviceName !== "daemon" && serviceName !== "dashboard") {
    console.error(`Unknown service: ${serviceName}`);
    console.error("Valid services: daemon, dashboard");
    process.exit(1);
  }

  const root = findMonorepoRoot();
  if (!root) {
    console.error("Could not find agent-friday monorepo root.");
    process.exit(1);
  }

  const service: ServiceName = serviceName;
  const info = SERVICES[service];
  const state = readState(service);

  if (!state) {
    console.error(`${info.label} is not running.`);
    console.error(`Use 'friday start ${service}' to start it.`);
    process.exit(1);
  }

  const mode = state.mode;
  console.log(`Restarting ${info.label} in ${mode} mode...`);

  killService(state);
  // Don't removeState preemptively. launchDev/launchProd overwrite state on
  // success; on failure we want the old (now stale) state to linger as a
  // breadcrumb so `friday status` reports `stale` instead of silently
  // forgetting the service ever existed.

  try {
    if (mode === "dev") {
      const { innerPid, sessionName } = launchDev(service, root);
      console.log(`  ${info.label} started in dev mode (PID ${innerPid}, tmux session ${sessionName})`);
    } else {
      const pid = launchProd(service, root);
      console.log(`  ${info.label} started in prod mode (PID ${pid})`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(`${info.label} did not relaunch — state file preserved for diagnosis.`);
    console.error(`Recover with: friday start ${service}${mode === "dev" ? " --dev" : ""}`);
    process.exit(1);
  }
}
