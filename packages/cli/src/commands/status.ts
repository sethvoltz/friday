import { defineCommand } from "citty";
import pc from "picocolors";
import { existsSync, readFileSync } from "node:fs";
import {
  ensureFridayEnv,
  HEALTH_PATH,
  loadConfig,
  SERVICES,
  type ServiceName,
} from "@friday/shared";
import { hasSession } from "../lib/tmux.js";
import { clearState, readState, tmuxSessionFor } from "../lib/state.js";
import { isAlive } from "../lib/proc.js";
import { DaemonClient } from "../lib/api.js";

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
    let health: Record<string, unknown> | null = null;
    if (existsSync(HEALTH_PATH)) {
      try {
        health = JSON.parse(readFileSync(HEALTH_PATH, "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        // ignore
      }
    }

    console.log();
    console.log(
      `  daemon API     ${reachable ? pc.green("reachable") : pc.red("not responding")} @ localhost:${cfg.daemonPort}`,
    );
    if (health) {
      console.log(pc.dim(`  daemon pid     ${health.pid}`));
      console.log(
        pc.dim(`  daemon uptime  ${formatUptime(Number(health.uptimeSec))}`),
      );
    }
    console.log(`  dashboard      http://localhost:${cfg.dashboardPort}`);
  },
});

function formatUptime(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}h ${m}m ${s}s`;
}
