import { defineCommand } from "citty";
import pc from "picocolors";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  LOGS_DIR,
  ensureFridayEnv,
  loadConfig,
  type ServiceName,
  SERVICES,
} from "@friday/shared";
import {
  hasSession,
  newSession,
  tmuxAvailable,
} from "../lib/tmux.js";
import {
  readState,
  tmuxSessionFor,
  writeState,
  type ServiceMode,
} from "../lib/state.js";
import { isAlive, spawnDetached } from "../lib/proc.js";

interface ServiceSpec {
  cwd: string;
  prodCmd: string;
  /**
   * Alternate command used when `friday start --dev`. Omit for services
   * where dev/prod doesn't apply.
   */
  devCmd?: string;
}

function tmuxSpecs(
  repoRoot: string,
  dashboardPort: number,
): Record<"daemon" | "dashboard", ServiceSpec> {
  return {
    daemon: {
      cwd: join(repoRoot, "services", "daemon"),
      prodCmd: "node dist/index.js",
      devCmd: "exec pnpm exec tsx watch src/index.ts",
    },
    dashboard: {
      cwd: join(repoRoot, "services", "dashboard"),
      prodCmd: "node build/index.js",
      devCmd: `exec pnpm exec vite dev --port ${dashboardPort}`,
    },
  };
}

function startTmuxService(
  service: "daemon" | "dashboard",
  spec: ServiceSpec,
  mode: ServiceMode,
): { started: boolean; detail: string } {
  const sessionName = tmuxSessionFor(service);
  const effectiveMode: ServiceMode =
    mode === "dev" && spec.devCmd ? "dev" : "prod";
  if (hasSession(sessionName)) {
    return { started: false, detail: `already running (${sessionName})` };
  }
  const cmd = effectiveMode === "dev" ? spec.devCmd! : spec.prodCmd;
  newSession(sessionName, cmd, spec.cwd);
  writeState({
    service,
    mode: effectiveMode,
    tmuxSession: sessionName,
    startedAt: new Date().toISOString(),
  });
  return { started: true, detail: `→ tmux session ${pc.cyan(sessionName)}` };
}

/**
 * The Cloudflare Tunnel runs as a detached background process — not a
 * tmux session — because it's a stateless connector with no dev/prod
 * distinction and no need for an interactive shell. cloudflared writes
 * its own log via `--logfile`; the pid is tracked in
 * `~/.friday/state/tunnel.json` for `friday stop` / `friday status`.
 */
function startTunnel(repoRoot: string): { started: boolean; detail: string } {
  const existing = readState("tunnel");
  if (existing?.pid && isAlive(existing.pid)) {
    return {
      started: false,
      detail: `already running (pid ${existing.pid})`,
    };
  }
  const logFile = join(LOGS_DIR, "tunnel.log");
  const pid = spawnDetached(
    "cloudflared",
    [
      "tunnel",
      "--no-autoupdate",
      "--logfile",
      logFile,
      "run",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        TUNNEL_TOKEN: process.env.CLOUDFLARE_TUNNEL_TOKEN,
      },
    },
  );
  writeState({
    service: "tunnel",
    mode: "prod",
    pid,
    startedAt: new Date().toISOString(),
  });
  return { started: true, detail: `→ pid ${pc.cyan(String(pid))}` };
}

function cloudflaredOnPath(): boolean {
  return spawnSync("which", ["cloudflared"], { stdio: "ignore" }).status === 0;
}

/**
 * Resolve why the tunnel can't start, if anything. Returns null when ready.
 */
function tunnelBlocker(): string | null {
  if (!process.env.CLOUDFLARE_TUNNEL_TOKEN) {
    return "no CLOUDFLARE_TUNNEL_TOKEN configured (run `friday setup --cloudflare`)";
  }
  if (!cloudflaredOnPath()) {
    return "cloudflared not on PATH (`brew install cloudflared`)";
  }
  return null;
}

export const startCommand = defineCommand({
  meta: {
    name: "start",
    description:
      "Start a service. `start` (no arg) starts daemon + dashboard (in tmux) plus the Cloudflare Tunnel (background daemon) when configured.",
  },
  args: {
    service: {
      type: "positional",
      required: false,
      description: `${SERVICES.join(" | ")} (default: all configured)`,
    },
    dev: {
      type: "boolean",
      description: "Dev mode for daemon + dashboard (tsx watch + vite dev). Ignored by tunnel.",
      default: false,
    },
  },
  async run({ args }) {
    if (!tmuxAvailable()) {
      console.error(pc.red("tmux not found. `brew install tmux`"));
      process.exit(1);
    }

    ensureFridayEnv();
    const cfg = loadConfig();
    const repoRoot = findRepoRoot();
    const tmuxAll = tmuxSpecs(repoRoot, cfg.dashboardPort);
    const mode: ServiceMode = args.dev ? "dev" : "prod";

    const target = (args.service as string | undefined)?.toLowerCase();
    let services: ServiceName[] = target
      ? validateService(target)
        ? [target as ServiceName]
        : ((): ServiceName[] => {
            console.error(
              pc.red(`unknown service: ${target}`) + ` (expected: ${SERVICES.join(" | ")})`,
            );
            process.exit(1);
          })()
      : [...SERVICES];

    const tunnelExplicit = target === "tunnel";
    const blocker = tunnelBlocker();
    if (services.includes("tunnel") && blocker) {
      if (tunnelExplicit) {
        console.error(pc.red(`cannot start tunnel: ${blocker}`));
        process.exit(1);
      }
      services = services.filter((s) => s !== "tunnel");
      console.log(pc.dim(`  · tunnel skipped — ${blocker}`));
    }

    console.log(pc.green(`starting ${services.join(" + ")} in ${mode} mode`));
    for (const svc of services) {
      const r =
        svc === "tunnel"
          ? startTunnel(repoRoot)
          : startTmuxService(svc, tmuxAll[svc], mode);
      const icon = r.started ? pc.green("✓") : pc.yellow("·");
      console.log(`  ${icon} ${svc.padEnd(10)} ${r.detail}`);
    }

    console.log();
    console.log(pc.dim(`  daemon API     http://localhost:${cfg.daemonPort}`));
    console.log(pc.dim(`  dashboard      http://localhost:${cfg.dashboardPort}`));
    if (services.includes("tunnel") && cfg.publicUrl) {
      console.log(pc.dim(`  public URL     ${cfg.publicUrl}`));
    }
    console.log(pc.dim(`  attach with:   friday attach <daemon|dashboard>`));
    console.log(pc.dim(`  tunnel logs:   friday logs tunnel -f`));
  },
});

function validateService(s: string): s is ServiceName {
  return (SERVICES as readonly string[]).includes(s);
}

function findRepoRoot(): string {
  let cur = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(cur, "pnpm-workspace.yaml"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}
