import { spawn } from "node:child_process";
import {
  type ServiceName,
  SERVICES,
  readPid,
  writePid,
  removePid,
  isRunning,
  findMonorepoRoot,
} from "../services.js";

export function restartCommand(args: string[]): void {
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

  // Stop
  const pid = readPid(service);
  if (pid && isRunning(pid)) {
    try {
      process.kill(pid, "SIGTERM");
      console.log(`  ${info.label} stopped (PID ${pid})`);
    } catch {
      // Already gone
    }
    removePid(service);
  }

  // Start
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
