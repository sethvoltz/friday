import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { FRIDAY_DIR } from "@friday/shared";
import { type ServiceName, SERVICES, isRunning } from "../services.js";
import { readState, type ServiceState } from "../state.js";
import { hasSession, isPaneDead } from "../tmux.js";

interface HealthData {
  pid: number;
  startedAt: string;
  lastHeartbeat: string;
  uptimeMs: number;
}

export type ServiceStatusState = "stopped" | "running" | "crashed" | "stale";

export interface ServiceStatusJson {
  service: ServiceName;
  state: ServiceStatusState;
  mode: "dev" | "prod" | null;
  pid: number | null;
  tmuxSession: string | null;
  startedAt: string | null;
  startCommand: string[] | null;
  logPath: string | null;
  /** ISO timestamp of the last line in the JSONL log, or null if missing/empty. */
  lastLogTs: string | null;
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

/**
 * Read the last JSONL line of `path` and return its `ts` field. Reads the
 * tail of the file (up to 4 KiB) — enough for the structured logger's lines
 * which are well under that, and avoids loading multi-megabyte logs.
 */
function readLastLogTs(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const size = statSync(path).size;
    if (size === 0) return null;
    const tailSize = Math.min(4096, size);
    const buf = Buffer.alloc(tailSize);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, tailSize, size - tailSize);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString("utf-8");
    const lines = text.split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    const last = lines[lines.length - 1];
    const obj = JSON.parse(last);
    return typeof obj.ts === "string" ? obj.ts : null;
  } catch {
    return null;
  }
}

function classify(state: ServiceState | null): ServiceStatusState {
  if (!state) return "stopped";
  const pidAlive = isRunning(state.pid);
  if (state.mode === "dev") {
    const session = state.tmuxSession ?? "";
    const sessionLive = session && hasSession(session);
    if (sessionLive && pidAlive && !isPaneDead(session)) return "running";
    if (sessionLive && (!pidAlive || isPaneDead(session))) return "crashed";
    if (!sessionLive && !pidAlive) return "stale";
    if (!sessionLive && pidAlive) return "stale"; // mismatch: process alive but no session
    return "running";
  }
  // prod
  return pidAlive ? "running" : "stale";
}

function buildStatusJson(service: ServiceName): ServiceStatusJson {
  const state = readState(service);
  const stateName = classify(state);
  return {
    service,
    state: stateName,
    mode: state?.mode ?? null,
    pid: state?.pid ?? null,
    tmuxSession: state?.tmuxSession ?? null,
    startedAt: state?.startedAt ?? null,
    startCommand: state?.command ?? null,
    logPath: state?.logPath ?? null,
    lastLogTs: state?.logPath ? readLastLogTs(state.logPath) : null,
  };
}

function recoveryHint(s: ServiceStatusJson): string {
  const svc = s.service;
  if (s.state === "crashed") {
    return `\`friday attach ${svc}\` to inspect; \`friday restart ${svc}\` to relaunch`;
  }
  if (s.state === "stale") {
    const flag = s.mode === "dev" ? " --dev" : "";
    return `\`friday start ${svc}${flag}\` to relaunch (handles stale state)`;
  }
  return "";
}

function printHumanLine(s: ServiceStatusJson): void {
  const info = SERVICES[s.service];
  const icons: Record<ServiceStatusState, string> = {
    running: "✓",
    stopped: "✗",
    crashed: "⚠",
    stale: "⚠",
  };
  let detail: string;
  if (s.state === "running") {
    detail = `running (${s.mode}, PID ${s.pid}${s.tmuxSession ? `, tmux ${s.tmuxSession}` : ""})`;
  } else if (s.state === "crashed") {
    detail = `crashed (tmux ${s.tmuxSession} alive but pane dead) — ${recoveryHint(s)}`;
  } else if (s.state === "stale") {
    detail = `stale (state file out of sync with reality) — ${recoveryHint(s)}`;
  } else {
    detail = "not running";
  }
  console.log(`  ${icons[s.state]} ${info.label}: ${detail}`);
}

export const statusCommandCitty = defineCommand({
  meta: {
    name: "status",
    description: "Show running services and health. States: running | crashed | stale | stopped.",
  },
  args: {
    service: {
      type: "positional",
      required: false,
      description: "daemon | dashboard (default: all)",
    },
    json: {
      type: "boolean",
      description: "Emit machine-readable JSON (the contract for agents)",
      default: false,
    },
  },
  run({ args }) {
    const argv: string[] = [];
    if (args.json) argv.push("--json");
    if (typeof args.service === "string" && args.service.length > 0) {
      argv.push(args.service);
    }
    statusCommand(argv);
  },
});

export function statusCommand(args: string[] = []): void {
  const wantJson = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("--"));
  const targetService = positional[0] as ServiceName | undefined;

  const services: ServiceName[] = targetService
    ? [targetService]
    : (Object.keys(SERVICES) as ServiceName[]);

  if (wantJson) {
    const out = services.map(buildStatusJson);
    console.log(JSON.stringify(targetService ? out[0] : out, null, 2));
    return;
  }

  console.log("\nFriday Status");
  console.log("═".repeat(40));

  for (const svc of services) {
    printHumanLine(buildStatusJson(svc));
  }

  // Health file (daemon heartbeat) — supplement, only when targeting daemon or all
  if (!targetService || targetService === "daemon") {
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
  }

  console.log();
}
