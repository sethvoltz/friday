import { existsSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { FRIDAY_DIR, getLogPath } from "@friday/shared";
import { readState, writeState, type ServiceState } from "./state.js";

const LEGACY_PIDS_DIR = join(FRIDAY_DIR, "pids");

/**
 * Look up a PID's command line via `ps -p`. Returns null if the PID is gone
 * (so `ps` exits non-zero) or the output isn't parseable.
 */
function psCommand(pid: number): string | null {
  try {
    const out = execSync(`ps -p ${pid} -o command=`, {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Look up a PID's start time as an ISO timestamp. macOS `ps -o lstart=` emits
 * something like "Thu May  1 13:32:17 2026", which we parse via Date. On
 * failure, fall back to the current time — the synthesized state record is
 * a best-effort migration anyway.
 */
function psStartTime(pid: number): string {
  try {
    const out = execSync(`ps -p ${pid} -o lstart=`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const d = new Date(out);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch {
    // fallthrough
  }
  return new Date().toISOString();
}

/**
 * Heuristic: does this command line look like one of our services?
 * The legacy `friday start` invoked `pnpm --filter @friday/<pkg> run start`,
 * so we look for either the package label or a node/tsx process running our
 * code path. Conservative — if we can't confirm, we drop the entry rather
 * than fabricate a state record around a recycled PID.
 */
function looksLikeFridayProcess(cmd: string, service: string): boolean {
  const pkg = `@friday/${service === "daemon" ? "daemon" : "dashboard"}`;
  if (cmd.includes(pkg)) return true;
  // Fallback: pnpm/node running the build artifact for this service
  const distMarker = service === "daemon" ? "services/friday/dist" : "services/dashboard/build";
  return cmd.includes(distMarker);
}

/**
 * One-shot migration: promote any legacy ~/.friday/pids/<svc>.pid into the
 * new ~/.friday/state/<svc>.json layout. Idempotent — runs at the top of
 * every CLI invocation, but a no-op once the legacy dir is gone.
 *
 * Stale entries (PID gone, recycled to an unrelated process, or no
 * matching state file synthesizable) are silently dropped — this is a
 * cleanup step, not a recovery tool.
 */
export function migratePidsToState(): void {
  if (!existsSync(LEGACY_PIDS_DIR)) return;

  let entries: string[];
  try {
    entries = readdirSync(LEGACY_PIDS_DIR);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".pid")) continue;
    const service = entry.replace(/\.pid$/, "");
    const pidFilePath = join(LEGACY_PIDS_DIR, entry);

    let pid: number;
    try {
      pid = parseInt(readFileSync(pidFilePath, "utf-8").trim(), 10);
    } catch {
      try { unlinkSync(pidFilePath); } catch { /* ignore */ }
      continue;
    }

    if (isNaN(pid)) {
      try { unlinkSync(pidFilePath); } catch { /* ignore */ }
      continue;
    }

    // Validate the PID still maps to one of our services. If not (process
    // exited, PID recycled, or anything else), drop the legacy file.
    const cmd = psCommand(pid);
    if (!cmd || !looksLikeFridayProcess(cmd, service)) {
      try { unlinkSync(pidFilePath); } catch { /* ignore */ }
      continue;
    }

    // Don't overwrite if a state file already exists from a previous run.
    if (!readState(service)) {
      const synthesized: ServiceState = {
        pid,
        mode: "prod",
        startedAt: psStartTime(pid),
        command: ["friday", "start", service],
        logPath: getLogPath(service),
      };
      writeState(service, synthesized);
    }

    try { unlinkSync(pidFilePath); } catch { /* ignore */ }
  }

  // Drop the legacy dir if it's now empty.
  try {
    const remaining = readdirSync(LEGACY_PIDS_DIR);
    if (remaining.length === 0) rmdirSync(LEGACY_PIDS_DIR);
  } catch {
    // ignore
  }
}
