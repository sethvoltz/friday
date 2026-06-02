import { defineCommand } from "citty";
import pc from "picocolors";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  ensureFridayEnv,
  HEALTH_PATH,
  loadConfig,
  resolveDaemonPort,
  resolveDashboardPort,
} from "@friday/shared";
import { DaemonClient } from "../lib/api.js";
import { FRIDAY_LAUNCHD_LABEL } from "../lib/launchd.js";

/** A heartbeat older than this is treated as stale (heartbeat interval
 *  is 30s, so 60s gives one missed beat of grace before status falls
 *  back to config-derived values). */
const HEALTH_STALE_MS = 60_000;

interface HealthSnapshot {
  port?: number;
  pid?: number;
  uptimeSec?: number;
  stale: boolean;
  present: boolean;
}

/**
 * Read the daemon's `health.json` and report what's there. The `port`
 * field is the daemon's actually-bound HTTP port (added 2026-05-20);
 * older daemons that haven't been restarted since the field landed
 * won't have it — fall back to config in that case.
 *
 * Exported for tests.
 */
export function readHealth(): HealthSnapshot {
  if (!existsSync(HEALTH_PATH)) {
    return { stale: false, present: false };
  }
  try {
    const raw = JSON.parse(readFileSync(HEALTH_PATH, "utf8")) as {
      port?: number;
      pid?: number;
      uptimeSec?: number;
      ts?: string;
    };
    const mtimeMs = statSync(HEALTH_PATH).mtimeMs;
    const stale = Date.now() - mtimeMs > HEALTH_STALE_MS;
    return {
      port: typeof raw.port === "number" ? raw.port : undefined,
      pid: typeof raw.pid === "number" ? raw.pid : undefined,
      uptimeSec: typeof raw.uptimeSec === "number" ? raw.uptimeSec : undefined,
      stale,
      present: true,
    };
  } catch {
    return { stale: false, present: false };
  }
}

/**
 * Probe the dashboard at `port`. Returns the response status when the
 * server answers within `timeoutMs`, otherwise `null` for any failure
 * (connection refused, timeout, network error). The dashboard's root
 * usually 200s or redirects to `/login`; anything < 500 means the
 * process is alive and serving.
 *
 * Exported for tests.
 */
export async function probeDashboard(port: number, timeoutMs = 1000): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: controller.signal,
      redirect: "manual",
    });
    return res.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface LaunchdJob {
  loaded: boolean;
  pid?: number;
}

/**
 * Query launchd for a job's load + pid status. Replaces the tmux
 * session check from the pre-FRI-88 era. Friday writes its own plist
 * directly (label `com.sethvoltz.friday`, FRI-146 / ADR-034) — that's the
 * label we query.
 *
 * `launchctl print gui/<uid>/<label>` returns 0 when the job is
 * loaded; the textual output carries `pid = NNNN` when the job's
 * process is currently running.
 *
 * The helper is label-agnostic (doctor.ts queries the same way); only the
 * caller's label argument changed.
 *
 * Exported for tests.
 */
export function launchdJobStatus(label: string): LaunchdJob {
  const uid = process.getuid?.() ?? 0;
  const r = spawnSync("launchctl", ["print", `gui/${uid}/${label}`], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0) return { loaded: false };
  const out = r.stdout?.toString() ?? "";
  const m = out.match(/^\s*pid\s*=\s*(\d+)/m);
  return { loaded: true, pid: m ? Number(m[1]) : undefined };
}

function formatUptime(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}h ${m}m ${s}s`;
}

export const statusCommand = defineCommand({
  meta: { name: "status", description: "Show supervisor + daemon + dashboard + tunnel status" },
  async run() {
    ensureFridayEnv();
    const cfg = loadConfig();

    console.log(pc.bold("Friday status"));

    // Supervisor (launchd job com.sethvoltz.friday)
    const fridayJob = launchdJobStatus(FRIDAY_LAUNCHD_LABEL);
    if (fridayJob.loaded) {
      const detail =
        fridayJob.pid !== undefined
          ? `pid=${fridayJob.pid}`
          : "(loaded; no current pid — restarting?)";
      console.log(`  supervisor  ${pc.green("up")}  ${detail}  (launchd: ${FRIDAY_LAUNCHD_LABEL})`);
    } else {
      console.log(`  supervisor  ${pc.dim("down")}  (run ${pc.cyan("friday start")})`);
    }

    // cloudflared (its own user launch agent installed by
    // `friday setup --cloudflare` → `cloudflared service install`; only
    // checked when a token is configured).
    if (process.env.CLOUDFLARE_TUNNEL_TOKEN) {
      const cfJob = launchdJobStatus("com.cloudflare.cloudflared");
      if (cfJob.loaded) {
        const detail = cfJob.pid !== undefined ? `pid=${cfJob.pid}` : "(loaded)";
        const suffix = cfg.publicUrl ? `  ${pc.cyan(cfg.publicUrl)}` : "";
        console.log(`  tunnel      ${pc.green("up")}  ${detail}${suffix}`);
      } else {
        console.log(
          `  tunnel      ${pc.dim("down")}  (run ${pc.cyan("friday setup --cloudflare")})`,
        );
      }
    }

    // Daemon API — actually-bound port from health.json, plus an HTTP
    // ping. The FRI-83 probe semantics carry forward unchanged.
    const client = new DaemonClient();
    const reachable = await client.ping();
    const health = readHealth();
    const cfgDaemonPort = resolveDaemonPort(cfg);
    let daemonPort: number;
    let daemonPortSource: string;
    if (health.present && !health.stale && typeof health.port === "number") {
      daemonPort = health.port;
      daemonPortSource = "probed";
    } else if (health.present && health.stale) {
      daemonPort = cfgDaemonPort;
      daemonPortSource = "config — heartbeat stale";
    } else {
      daemonPort = cfgDaemonPort;
      daemonPortSource = "config — no heartbeat";
    }
    const daemonPortTag =
      daemonPortSource === "probed"
        ? pc.dim(`(${daemonPortSource})`)
        : pc.yellow(`(${daemonPortSource})`);
    console.log();
    console.log(
      `  daemon API     ${reachable ? pc.green("reachable") : pc.red("not responding")} @ localhost:${daemonPort} ${daemonPortTag}`,
    );
    if (health.present) {
      if (health.pid !== undefined) {
        console.log(pc.dim(`  daemon pid     ${health.pid}`));
      }
      if (health.uptimeSec !== undefined) {
        console.log(pc.dim(`  daemon uptime  ${formatUptime(health.uptimeSec)}`));
      }
    }

    // Dashboard — probe-validated.
    const cfgDashboardPort = resolveDashboardPort(cfg);
    const dashboardStatus = await probeDashboard(cfgDashboardPort);
    const dashboardReachable = dashboardStatus !== null && dashboardStatus < 500;
    if (dashboardReachable) {
      console.log(`  dashboard      ${pc.green("up")} @ http://localhost:${cfgDashboardPort}`);
    } else {
      console.log(
        `  dashboard      ${pc.red("down")} (config: http://localhost:${cfgDashboardPort})`,
      );
    }

    // zero-cache is internal-only behind the dashboard's `/api/sync` WS
    // proxy. `friday doctor` covers reachability; status surfaces the
    // literal endpoint for operator context.
    console.log(pc.dim(`  zero-cache     ws://localhost:4848`));
  },
});
