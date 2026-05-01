import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLogPath } from "@friday/shared";
import { readState, writeState, removeState, type ServiceState } from "./state.js";

export type ServiceName = "daemon" | "dashboard";

export interface ServiceInfo {
  label: string;
  package: string;
  /** pnpm script name for prod start (`pnpm --filter <pkg> run <script>`). */
  script: string;
  /** Service-relative subdirectory under the monorepo root. */
  cwd: string;
  /** Prod artifact whose mtime is compared against `srcDir` for freshness. */
  artifactPath: string;
  /** Source dir whose newest mtime gates prod start. */
  srcDir: string;
  /** Command launched inside the dev tmux session. Run with `pnpm exec`
   *  from `cwd`, prefixed by `exec ` so the shell is replaced and pane_pid
   *  ends up being pnpm itself (not an extra shell layer). */
  devCommand: string;
}

export const SERVICES: Record<ServiceName, ServiceInfo> = {
  daemon: {
    label: "Friday daemon",
    package: "@friday/daemon",
    script: "start",
    cwd: "services/friday",
    artifactPath: "services/friday/dist/index.js",
    srcDir: "services/friday/src",
    devCommand: "tsx watch src/index.ts",
  },
  dashboard: {
    label: "Dashboard",
    package: "@friday/dashboard",
    script: "start",
    cwd: "services/dashboard",
    artifactPath: "services/dashboard/build/index.js",
    srcDir: "services/dashboard/src",
    devCommand: "vite dev",
  },
};

/**
 * Backwards-compatible PID accessor. Reads the modern state file and returns
 * just the inner pid. Existing call sites in start/stop/restart/status keep
 * working until Phase 3+4 rewrite them against the richer state API.
 */
export function readPid(service: ServiceName): number | null {
  const state = readState(service);
  return state?.pid ?? null;
}

/**
 * Backwards-compatible PID writer. Synthesizes a minimal `ServiceState` —
 * caller didn't supply mode or argv, so we record `mode: "prod"` and a
 * best-guess command. New code paths in Phase 3 should call `writeState`
 * directly with the full record.
 */
export function writePid(service: ServiceName, pid: number): void {
  const existing = readState(service);
  const state: ServiceState = existing ?? {
    pid,
    mode: "prod",
    startedAt: new Date().toISOString(),
    command: ["friday", "start", service],
    logPath: getLogPath(service),
  };
  writeState(service, { ...state, pid });
}

export function removePid(service: ServiceName): void {
  removeState(service);
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but we lack permission to signal it
    if (err?.code === "EPERM") return true;
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
