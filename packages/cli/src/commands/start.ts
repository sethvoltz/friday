import { spawn } from "node:child_process";
import {
  type ServiceName,
  SERVICES,
  readPid,
  writePid,
  isRunning,
  parseServiceArg,
  findMonorepoRoot,
} from "../services.js";

function startService(service: ServiceName, root: string): void {
  const info = SERVICES[service];
  const existing = readPid(service);

  if (existing && isRunning(existing)) {
    console.log(`  ${info.label} is already running (PID ${existing})`);
    return;
  }

  const child = spawn("pnpm", ["--filter", info.package, "run", info.script], {
    cwd: root,
    stdio: "ignore",
    detached: true,
  });

  if (child.pid) {
    writePid(service, child.pid);
    child.unref();
    console.log(`  ${info.label} started (PID ${child.pid})`);
  } else {
    console.error(`  Failed to start ${info.label}`);
  }
}

export function startCommand(args: string[]): void {
  const root = findMonorepoRoot();
  if (!root) {
    console.error("Could not find agent-friday monorepo root (pnpm-workspace.yaml).");
    console.error("Run this command from within the monorepo, or build services first.");
    process.exit(1);
  }

  const target = parseServiceArg(args[0]);
  const services: ServiceName[] = target === "all" ? ["daemon", "dashboard"] : [target];

  console.log("Starting services...");
  for (const service of services) {
    startService(service, root);
  }
}
