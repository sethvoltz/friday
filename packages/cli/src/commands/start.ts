import { defineCommand } from "citty";
import pc from "picocolors";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  LOGS_DIR,
  ensureFridayEnv,
  getLogPath,
  loadConfig,
  resolveDaemonPort,
  resolveDashboardPort,
  type ServiceName,
  SERVICES,
} from "@friday/shared";
import {
  hasSession,
  newSession,
  tmuxAvailable,
} from "../lib/tmux.js";
import { readState, tmuxSessionFor, writeState } from "../lib/state.js";
import { isAlive, spawnDetached } from "../lib/proc.js";

/**
 * `--dev` was retired with FRI-83 — `friday start` always launches the
 * prod-built artifacts now. Dev runs via root-package `pnpm dev:daemon`
 * / `pnpm dev:dashboard` wrappers instead, so dev never touches the
 * running prod fleet by default. If you're reaching for `--dev` here
 * out of muscle memory, citty will reject the unknown flag — that's
 * the new user-facing signpost.
 */

interface ServiceSpec {
  cwd: string;
  prodCmd: string;
}

type TmuxService = "daemon" | "dashboard" | "zero-cache";

function tmuxSpecs(
  repoRoot: string,
  dashboardPort: number,
): Record<TmuxService, ServiceSpec> {
  return {
    daemon: {
      cwd: join(repoRoot, "services", "daemon"),
      prodCmd: "node dist/index.js",
    },
    dashboard: {
      cwd: join(repoRoot, "services", "dashboard"),
      // Custom entrypoint that wraps adapter-node's handler with a
      // `/api/sync` WebSocket reverse-proxy to zero-cache (see
      // server-entry.mjs). adapter-node's only port knob is `PORT`
      // env, so we pass the resolved dashboard port (cfg.dashboardPort
      // ?? PROD_DASHBOARD_PORT) through to it here. Dev mode uses
      // vite dev's hardcoded 5173 from `vite.config.ts` — invoked
      // separately via `pnpm dev:dashboard`, not from this CLI.
      prodCmd: `PORT=${dashboardPort} node server-entry.mjs`,
    },
    // zero-cache is a stateless sidecar; it replicates from Postgres
    // (ZERO_UPSTREAM_DB) into its own internal sqlite (ZERO_REPLICA_FILE)
    // and serves WS clients on port 4848. ADR-024. Zero lives in the
    // dashboard's deps (it's also the Zero client host), so we spawn
    // the binary from that package — its node_modules/.bin/zero-cache
    // is the canonical path.
    //
    // Restart loop: zero-cache exits with code 14 on AutoResetSignal
    // (replica out-of-sync; needs a fresh sync from upstream). The
    // parent runner expects us to restart it; tmux on its own doesn't,
    // so we wrap in a `while true` loop with a short backoff. A
    // pathological crash loop will still spin every second — that's
    // visible in `friday attach zero-cache` so the operator can see it.
    "zero-cache": {
      cwd: join(repoRoot, "services", "dashboard"),
      // Source ~/.friday/.env before exec — zero-cache reads its
      // upstream + replica config from env vars (ZERO_UPSTREAM_DB,
      // ZERO_REPLICA_FILE, ZERO_AUTH_SECRET, ZERO_APP_PUBLICATIONS,
      // ZERO_MUTATE_URL), and the tmux session's parent shell may
      // not have those exported. `set -a` auto-exports every var
      // assigned by the source.
      //
      // Deploy Zero permissions before the cache boots. The schema's
      // `definePermissions(...)` block only takes effect once it's
      // written into upstream Postgres via `zero-deploy-permissions`;
      // without this step zero-cache logs "No permission rules found
      // for table 'X'. No rows will be returned." on every subscribe
      // and the client sees empty materializations. Idempotent — the
      // tool no-ops when the deployed hash already matches.
      //
      // ZERO_LOG_FORMAT=json makes every log line a structured JSON
      // record so the dashboard's `/api/logs/zero-cache` endpoint can
      // parse and color-code by `level` the same way it does for
      // daemon + dashboard. The `tee -a` after `2>&1` mirrors the
      // stream to `~/.friday/logs/zero-cache.jsonl` AND keeps it
      // visible in the tmux pane (`friday attach zero-cache`). The
      // file is the only durable artifact across daemon restarts —
      // tmux scrollback is bounded and resets when the session is
      // killed.
      // `ZERO_MUTATE_URL` is exported AFTER sourcing `.env` so the
      // dynamically-resolved dashboard port wins over whatever stale
      // value the .env carries (this file is written once at
      // `friday setup` time and isn't re-emitted when ports change).
      // Same shape as `resolveDaemonPort` / `resolveDashboardPort` for
      // every other port consumer — config drives the running value.
      prodCmd:
        'set -a && source ~/.friday/.env && set +a && ' +
        `export ZERO_MUTATE_URL="http://localhost:${dashboardPort}/api/mutators" && ` +
        'pnpm exec zero-deploy-permissions --schema-path ../../packages/shared/dist/sync/schema.js && ' +
        `while true; do ` +
        `ZERO_LOG_FORMAT=json pnpm exec zero-cache 2>&1 | tee -a "${getLogPath("zero-cache")}"; ` +
        `ec=\${PIPESTATUS[0]}; echo "zero-cache exited code $ec — restarting in 1s"; sleep 1; ` +
        `done`,
    },
  };
}

function startTmuxService(
  service: TmuxService,
  spec: ServiceSpec,
): { started: boolean; detail: string } {
  const sessionName = tmuxSessionFor(service);
  if (hasSession(sessionName)) {
    return { started: false, detail: `already running (${sessionName})` };
  }
  newSession(sessionName, spec.prodCmd, spec.cwd);
  writeState({
    service,
    tmuxSession: sessionName,
    startedAt: new Date().toISOString(),
  });
  return { started: true, detail: `→ tmux session ${pc.cyan(sessionName)}` };
}

/**
 * The Cloudflare Tunnel runs as a detached background process — not a
 * tmux session — because it's a stateless connector with no need for
 * an interactive shell. cloudflared writes its own log via
 * `--logfile`; the pid is tracked in `~/.friday/state/tunnel.json` for
 * `friday stop` / `friday status`.
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
    pid,
    startedAt: new Date().toISOString(),
  });
  return { started: true, detail: `→ pid ${pc.cyan(String(pid))}` };
}

function cloudflaredOnPath(): boolean {
  return spawnSync("which", ["cloudflared"], { stdio: "ignore" }).status === 0;
}

/**
 * Build every workspace package (`packages/**`) before launching services
 * (FIX_FORWARD 7.2). Both daemon and dashboard import `@friday/*` packages
 * via their compiled `dist/`, so a stale dist after a source edit silently
 * runs old code. Building here closes that loophole.
 *
 * The `**` recursion is load-bearing: `./packages/*` would miss nested
 * workspace packages like `packages/integrations/linear`, letting their
 * dist/ drift out of sync with source.
 *
 * Skipped when neither daemon nor dashboard is in the services list — e.g.
 * `friday start tunnel` doesn't need package builds.
 */
function buildPackagesOrAbort(repoRoot: string): void {
  const r = spawnSync(
    "pnpm",
    ["exec", "turbo", "build", "--filter=./packages/**"],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );
  if (r.status !== 0) {
    console.error(
      pc.red(
        "package build failed — refusing to start daemon/dashboard against a stale dist.",
      ),
    );
    console.error(
      pc.dim(
        "  fix the build errors above and re-run `friday start`, or run `pnpm -r build` for the full output.",
      ),
    );
    process.exit(1);
  }
}

/**
 * Build the SvelteKit dashboard. Turbo handles incrementality — a no-op
 * build returns in a few hundred ms when nothing under `services/dashboard/`
 * has changed since the last build.
 */
function buildDashboardOrAbort(repoRoot: string): void {
  const r = spawnSync(
    "pnpm",
    ["exec", "turbo", "build", "--filter=@friday/dashboard"],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );
  if (r.status !== 0) {
    console.error(
      pc.red(
        "dashboard build failed — refusing to start prod-mode dashboard against a stale or missing build/.",
      ),
    );
    console.error(
      pc.dim(
        "  fix the build errors above and re-run `friday start dashboard`.",
      ),
    );
    process.exit(1);
  }
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
      "Start a service. `start` (no arg) starts daemon + dashboard + zero-cache (in tmux) plus the Cloudflare Tunnel (background daemon) when configured. Always prod mode; for dev see `pnpm dev:daemon` / `pnpm dev:dashboard`.",
  },
  args: {
    service: {
      type: "positional",
      required: false,
      description: `${SERVICES.join(" | ")} (default: all configured)`,
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
    const daemonPort = resolveDaemonPort(cfg);
    const dashboardPort = resolveDashboardPort(cfg);
    const tmuxAll = tmuxSpecs(repoRoot, dashboardPort);

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

    // Build workspace packages before launching anything that imports their
    // dist/. The tunnel doesn't need them, so skip when only tunnel is
    // queued (FIX_FORWARD 7.2).
    //
    // Also build the dashboard service itself — `node server-entry.mjs`
    // runs whatever's already in `services/dashboard/build/`, and that
    // artifact does not auto-update when the dashboard source changes.
    // Until this gate landed, `friday restart dashboard` after a source
    // edit silently kept serving the previous bundle, producing the
    // worst possible feedback loop: "the fix doesn't work" reports
    // against changes that simply hadn't shipped.
    const needsPackages = services.some(
      (s) => s === "daemon" || s === "dashboard",
    );
    if (needsPackages) {
      console.log(pc.dim("  · building workspace packages…"));
      buildPackagesOrAbort(repoRoot);
    }
    if (services.includes("dashboard")) {
      console.log(pc.dim("  · building dashboard…"));
      buildDashboardOrAbort(repoRoot);
    }

    console.log(pc.green(`starting ${services.join(" + ")}`));
    for (const svc of services) {
      const r =
        svc === "tunnel"
          ? startTunnel(repoRoot)
          : startTmuxService(svc, tmuxAll[svc]);
      const icon = r.started ? pc.green("✓") : pc.yellow("·");
      console.log(`  ${icon} ${svc.padEnd(10)} ${r.detail}`);
    }

    console.log();
    console.log(pc.dim(`  daemon API     http://localhost:${daemonPort}`));
    console.log(pc.dim(`  dashboard      http://localhost:${dashboardPort}`));
    console.log(pc.dim(`  zero-cache     ws://localhost:4848`));
    if (services.includes("tunnel") && cfg.publicUrl) {
      console.log(pc.dim(`  public URL     ${cfg.publicUrl}`));
    }
    console.log(
      pc.dim(`  attach with:   friday attach <daemon|dashboard|zero-cache>`),
    );
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
