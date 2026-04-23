import { spawn } from "node:child_process";
import {
  type ServiceName,
  SERVICES,
  readPid,
  isRunning,
  removePid,
  parseServiceArg,
  findMonorepoRoot,
} from "../services.js";

const DEV_SCRIPTS: Record<ServiceName, string> = {
  daemon: "dev",
  dashboard: "dev",
};

function startDevService(service: ServiceName, root: string): void {
  const info = SERVICES[service];
  const existing = readPid(service);

  if (existing && isRunning(existing)) {
    console.log(`  ${info.label} is already running (PID ${existing})`);
    return;
  }

  console.log(`  Starting ${info.label} in dev mode...`);
  spawn("pnpm", ["--filter", info.package, "run", DEV_SCRIPTS[service]], {
    cwd: root,
    stdio: "inherit",
  });
}

function startDevAll(root: string): void {
  // Use turbo dev to start everything with proper orchestration
  console.log("  Starting all services in dev mode via turbo...");
  spawn("pnpm", ["run", "dev"], {
    cwd: root,
    stdio: "inherit",
  });
}

export function devCommand(args: string[]): void {
  const subcommand = args[0];

  if (!subcommand) {
    console.error("Usage: friday dev <start|restart> [service]");
    process.exit(1);
  }

  const root = findMonorepoRoot();
  if (!root) {
    console.error("Could not find agent-friday monorepo root.");
    console.error("Dev commands must be run from within the monorepo.");
    process.exit(1);
  }

  if (subcommand === "start") {
    const target = parseServiceArg(args[1]);
    if (target === "all") {
      startDevAll(root);
    } else {
      startDevService(target, root);
    }
    return;
  }

  if (subcommand === "restart") {
    const serviceName = args[1];
    if (!serviceName) {
      console.error("Usage: friday dev restart <service>");
      console.error("A service name is required: daemon or dashboard");
      process.exit(1);
    }

    if (serviceName !== "daemon" && serviceName !== "dashboard") {
      console.error(`Unknown service: ${serviceName}`);
      process.exit(1);
    }

    const service: ServiceName = serviceName;
    const info = SERVICES[service];

    // Kill existing
    const pid = readPid(service);
    if (pid && isRunning(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`  ${info.label} stopped (PID ${pid})`);
      } catch {
        // already gone
      }
      removePid(service);
    }

    // Restart in dev mode
    startDevService(service, root);
    return;
  }

  console.error(`Unknown dev command: ${subcommand}`);
  console.error("Valid commands: start, restart");
  process.exit(1);
}
