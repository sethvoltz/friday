import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { FRIDAY_DIR } from "@friday/shared";

const PIDS_DIR = join(FRIDAY_DIR, "pids");

export type ServiceName = "daemon" | "dashboard";

export const SERVICES: Record<ServiceName, { label: string; package: string; script: string }> = {
  daemon: { label: "Friday daemon", package: "@friday/daemon", script: "start" },
  dashboard: { label: "Dashboard", package: "@friday/dashboard", script: "preview" },
};

function pidFile(service: ServiceName): string {
  return join(PIDS_DIR, `${service}.pid`);
}

export function readPid(service: ServiceName): number | null {
  const path = pidFile(service);
  if (!existsSync(path)) return null;
  const pid = parseInt(readFileSync(path, "utf-8").trim(), 10);
  if (isNaN(pid)) return null;
  return pid;
}

export function writePid(service: ServiceName, pid: number): void {
  mkdirSync(PIDS_DIR, { recursive: true });
  writeFileSync(pidFile(service), String(pid), "utf-8");
}

export function removePid(service: ServiceName): void {
  const path = pidFile(service);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseServiceArg(arg: string | undefined): ServiceName | "all" {
  if (!arg || arg === "all") return "all";
  if (arg === "daemon" || arg === "dashboard") return arg;
  console.error(`Unknown service: ${arg}`);
  console.error("Valid services: daemon, dashboard");
  process.exit(1);
}

export function findMonorepoRoot(): string | null {
  // Walk up from CLI package to find pnpm-workspace.yaml
  let dir = new URL(".", import.meta.url).pathname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
