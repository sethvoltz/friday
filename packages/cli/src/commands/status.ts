import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FRIDAY_DIR } from "@friday/shared";
import { type ServiceName, SERVICES, readPid, isRunning, removePid } from "../services.js";

interface HealthData {
  pid: number;
  startedAt: string;
  lastHeartbeat: string;
  uptimeMs: number;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function serviceStatus(service: ServiceName): { running: boolean; pid: number | null; detail: string } {
  const pid = readPid(service);
  if (!pid) return { running: false, pid: null, detail: "not running" };

  if (!isRunning(pid)) {
    removePid(service);
    return { running: false, pid, detail: "not running (stale PID cleaned)" };
  }

  return { running: true, pid, detail: `running (PID ${pid})` };
}

export function statusCommand(): void {
  console.log("\nFriday Status");
  console.log("\u2550".repeat(40));

  // Service status
  for (const [name, info] of Object.entries(SERVICES)) {
    const { running, detail } = serviceStatus(name as ServiceName);
    const icon = running ? "\u2713" : "\u2717";
    console.log(`  ${icon} ${info.label}: ${detail}`);
  }

  // Health file (daemon heartbeat)
  const healthPath = join(FRIDAY_DIR, "health.json");
  if (existsSync(healthPath)) {
    try {
      const health: HealthData = JSON.parse(readFileSync(healthPath, "utf-8"));
      const age = Date.now() - new Date(health.lastHeartbeat).getTime();
      const fresh = age < 60_000;

      console.log();
      console.log("  Daemon health:");
      console.log(`    PID:            ${health.pid}`);
      console.log(`    Uptime:         ${formatDuration(health.uptimeMs)}`);
      console.log(`    Last heartbeat: ${fresh ? `${Math.floor(age / 1000)}s ago` : `${Math.floor(age / 60000)}m ago (stale)`}`);
    } catch {
      // Malformed health file
    }
  }

  console.log();
}
