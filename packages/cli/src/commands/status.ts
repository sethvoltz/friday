import { defineCommand } from "citty";
import pc from "picocolors";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  ensureFridayEnv,
  HEALTH_PATH,
  loadConfig,
  resolveDaemonPort,
  resolveDashboardPort,
  SERVICES,
  type ServiceName,
} from "@friday/shared";
import { hasSession } from "../lib/tmux.js";
import { clearState, readState, tmuxSessionFor } from "../lib/state.js";
import { isAlive } from "../lib/proc.js";
import { DaemonClient } from "../lib/api.js";

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
      uptimeSec:
        typeof raw.uptimeSec === "number" ? raw.uptimeSec : undefined,
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
export async function probeDashboard(
  port: number,
  timeoutMs = 1000,
): Promise<number | null> {
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

export const statusCommand = defineCommand({
  meta: { name: "status", description: "Show daemon + dashboard status" },
  async run() {
    ensureFridayEnv();
    const cfg = loadConfig();
    const tunnelTokenSet = !!process.env.CLOUDFLARE_TUNNEL_TOKEN;

    console.log(pc.bold("Friday status"));
    for (const svc of SERVICES) {
      const state = readState(svc);

      if (svc === "tunnel") {
        // Skip the tunnel row on installs that haven't opted in, to keep
        // the default `friday status` uncluttered.
        if (!tunnelTokenSet && !state) continue;
        const alive = !!state?.pid && isAlive(state.pid);
        if (state && state.pid && !alive) {
          // pid file lingered after the process died — clear it so the
          // next command starts cleanly.
          clearState("tunnel");
        }
        const tag = alive ? pc.green("up") : pc.dim("down");
        const detail = alive
          ? `pid=${state!.pid}`
          : state?.pid
            ? `(stale pid ${state.pid})`
            : "not started";
        const suffix = alive && cfg.publicUrl ? `  ${pc.cyan(cfg.publicUrl)}` : "";
        console.log(`  ${svc.padEnd(10)} ${tag}  ${detail}${suffix}`);
        continue;
      }

      const session = tmuxSessionFor(svc);
      const up = hasSession(session);
      const mode = state?.mode ?? "—";
      const tag = up ? pc.green("up") : pc.dim("down");
      console.log(
        `  ${svc.padEnd(10)} ${tag}  mode=${mode}  session=${session}`,
      );
    }

    const client = new DaemonClient();
    const reachable = await client.ping();
    const health = readHealth();

    // Daemon's actually-bound port (from health.json's `port` field,
    // written by the daemon after `startServer` returns). Stale or
    // missing heartbeat falls back to the config-resolved value and
    // surfaces the discrepancy.
    const cfgDaemonPort = resolveDaemonPort(cfg);
    let daemonPort = cfgDaemonPort;
    let daemonPortSource = "config";
    if (health.present && !health.stale && typeof health.port === "number") {
      daemonPort = health.port;
      daemonPortSource = "probed";
    } else if (health.present && health.stale) {
      daemonPortSource = "config — heartbeat stale";
    } else {
      daemonPortSource = "config — no heartbeat";
    }

    // Dashboard probe — `start.ts` passes `resolveDashboardPort(cfg)`
    // as the PORT env. If the dashboard answered we trust that port is
    // right; if not, fall back to the resolved value with a
    // "(config: …)" hint.
    const cfgDashboardPort = resolveDashboardPort(cfg);
    const dashboardStatus = await probeDashboard(cfgDashboardPort);
    const dashboardReachable = dashboardStatus !== null && dashboardStatus < 500;

    console.log();
    const daemonPortTag = daemonPortSource === "probed"
      ? pc.dim(`(${daemonPortSource})`)
      : pc.yellow(`(${daemonPortSource})`);
    console.log(
      `  daemon API     ${reachable ? pc.green("reachable") : pc.red("not responding")} @ localhost:${daemonPort} ${daemonPortTag}`,
    );
    if (health.present) {
      if (health.pid !== undefined) {
        console.log(pc.dim(`  daemon pid     ${health.pid}`));
      }
      if (health.uptimeSec !== undefined) {
        console.log(
          pc.dim(`  daemon uptime  ${formatUptime(health.uptimeSec)}`),
        );
      }
    }
    if (dashboardReachable) {
      console.log(
        `  dashboard      ${pc.green("up")} @ http://localhost:${cfgDashboardPort}`,
      );
    } else {
      console.log(
        `  dashboard      ${pc.red("down")} (config: http://localhost:${cfgDashboardPort})`,
      );
    }
    // zero-cache is internal-only behind the dashboard's `/api/sync` WS
    // proxy; surface a literal so the operator knows where it should be.
    // `friday doctor` covers reachability.
    console.log(pc.dim(`  zero-cache     ws://localhost:4848`));
  },
});

function formatUptime(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}h ${m}m ${s}s`;
}
