import {
  type ServiceName,
  SERVICES,
  isRunning,
  parseServiceArg,
  findMonorepoRoot,
} from "../services.js";
import { readState, type ServiceState } from "../state.js";
import { launchProd, launchDev } from "../launch.js";

interface StartOptions {
  dev: boolean;
}

function parseArgs(args: string[]): { service: string | undefined; opts: StartOptions } {
  const opts: StartOptions = { dev: false };
  const positional: string[] = [];
  for (const a of args) {
    if (a === "--dev") opts.dev = true;
    else positional.push(a);
  }
  return { service: positional[0], opts };
}

function emitConflict(service: ServiceName, current: ServiceState): void {
  const label = SERVICES[service].label;
  const modeLabel = current.mode === "dev" ? "dev" : "prod";
  console.error(`${label} is already running in ${modeLabel} mode (PID ${current.pid}).`);
  if (current.mode === "dev") {
    console.error(`To switch modes: friday stop ${service} && friday start ${service}`);
  } else {
    console.error(`To switch modes: friday stop ${service} && friday start ${service} --dev`);
  }
  process.exit(1);
}

function startService(service: ServiceName, root: string, opts: StartOptions): void {
  const info = SERVICES[service];
  const existing = readState(service);
  if (existing && isRunning(existing.pid)) {
    emitConflict(service, existing);
  }

  try {
    if (opts.dev) {
      const { innerPid, sessionName } = launchDev(service, root);
      console.log(`  ${info.label} started in dev mode (PID ${innerPid}, tmux session ${sessionName})`);
      console.log(`  Attach: friday attach ${service}`);
      console.log(`  Logs:   friday logs ${service} -f`);
    } else {
      const pid = launchProd(service, root);
      console.log(`  ${info.label} started in prod mode (PID ${pid})`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export function startCommand(args: string[]): void {
  const root = findMonorepoRoot();
  if (!root) {
    console.error("Could not find agent-friday monorepo root (pnpm-workspace.yaml).");
    console.error("Run this command from within the monorepo, or build services first.");
    process.exit(1);
  }

  const { service: serviceArg, opts } = parseArgs(args);
  const target = parseServiceArg(serviceArg);
  const services: ServiceName[] = target === "all" ? ["daemon", "dashboard"] : [target];

  console.log(`Starting services${opts.dev ? " in dev mode" : ""}...`);
  for (const service of services) {
    startService(service, root, opts);
  }
}
