import {
  type ServiceName,
  SERVICES,
  readPid,
  removePid,
  isRunning,
  parseServiceArg,
} from "../services.js";

function stopService(service: ServiceName): void {
  const info = SERVICES[service];
  const pid = readPid(service);

  if (!pid) {
    console.log(`  ${info.label} is not running (no PID file)`);
    return;
  }

  if (!isRunning(pid)) {
    console.log(`  ${info.label} is not running (stale PID ${pid})`);
    removePid(service);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`  ${info.label} stopped (PID ${pid})`);
    removePid(service);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Failed to stop ${info.label} (PID ${pid}): ${msg}`);
  }
}

export function stopCommand(args: string[]): void {
  const target = parseServiceArg(args[0]);
  const services: ServiceName[] = target === "all" ? ["daemon", "dashboard"] : [target];

  console.log("Stopping services...");
  for (const service of services) {
    stopService(service);
  }
}
