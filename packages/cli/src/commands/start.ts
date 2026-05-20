import { defineCommand } from "citty";
import pc from "picocolors";
import { spawnSync } from "node:child_process";
import {
  ensureFridayEnv,
  loadConfig,
  resolveDaemonPort,
  resolveDashboardPort,
  SERVICES,
} from "@friday/shared";

/**
 * `friday start` — thin alias over `brew services start friday`.
 *
 * Post-FRI-88, supervision lives in launchd via the Homebrew formula
 * (`sethvoltz/friday/friday`). The plist runs `friday-supervisor`,
 * which forks daemon + dashboard + zero-cache as children with proper
 * process-group cascade-stop semantics. The tmux era is over.
 *
 * Single-service starts (`friday start daemon`) error out — the
 * supervisor owns the whole stack atomically. Operators bounce
 * individual services via `friday restart` (also whole-stack); the
 * per-service IPC story is an explicit follow-up ticket.
 *
 * cloudflared is its own brew service (`cloudflare/cloudflare/cloudflared`).
 * `friday start` ensures it's also running when a `CLOUDFLARE_TUNNEL_TOKEN`
 * is configured, but its lifecycle is independent of Friday's stack.
 */

function brewFridayInstalled(): boolean {
  const r = spawnSync("brew", ["list", "friday"], { stdio: "ignore" });
  return r.status === 0;
}

function brewCloudflaredInstalled(): boolean {
  const r = spawnSync("brew", ["list", "cloudflared"], { stdio: "ignore" });
  return r.status === 0;
}

export const startCommand = defineCommand({
  meta: {
    name: "start",
    description:
      "Start Friday's prod stack (delegates to `brew services start friday`). For dev hot-reload, use `pnpm dev:daemon` / `pnpm dev:dashboard`.",
  },
  args: {
    service: {
      type: "positional",
      required: false,
      description: "(unused — single-service ops not supported under launchd supervision)",
    },
  },
  async run({ args }) {
    if (args.service) {
      console.error(
        pc.red(
          `single-service operations not supported under launchd supervision.`,
        ),
      );
      console.error(
        `  the supervisor owns the whole stack atomically; bounce it with:`,
      );
      console.error(`    ${pc.cyan("friday restart")}    # whole stack`);
      console.error(
        `    ${pc.cyan("brew services restart friday")}    # same thing, no alias`,
      );
      console.error(
        `  per-service IPC is an explicit follow-up ticket — see ADR-028.`,
      );
      process.exit(1);
    }

    ensureFridayEnv();

    if (!brewFridayInstalled()) {
      console.error(pc.red("Friday isn't installed via brew."));
      console.error(`  install: ${pc.cyan("brew install sethvoltz/friday/friday")}`);
      console.error(
        `  this CLI delegates to ${pc.cyan("brew services start friday")} — no formula, no supervision.`,
      );
      process.exit(1);
    }

    console.log(pc.green("starting friday stack via brew services"));
    const r = spawnSync("brew", ["services", "start", "friday"], {
      stdio: "inherit",
    });
    if (r.status !== 0) process.exit(r.status ?? 1);

    // cloudflared is supervised independently. `friday start` kicks it
    // off too if a token is configured + the formula is installed —
    // a convenience, not a coupling.
    if (process.env.CLOUDFLARE_TUNNEL_TOKEN && brewCloudflaredInstalled()) {
      console.log(pc.dim("  · starting cloudflared (separate brew service)…"));
      spawnSync("brew", ["services", "start", "cloudflared"], { stdio: "inherit" });
    } else if (process.env.CLOUDFLARE_TUNNEL_TOKEN) {
      console.log(
        pc.dim(`  · cloudflared not installed — ${pc.cyan("brew install cloudflared")} to enable the tunnel`),
      );
    }

    const cfg = loadConfig();
    console.log();
    console.log(pc.dim(`  daemon API     http://localhost:${resolveDaemonPort(cfg)}`));
    console.log(pc.dim(`  dashboard      http://localhost:${resolveDashboardPort(cfg)}`));
    console.log(pc.dim(`  zero-cache     ws://localhost:4848`));
    if (cfg.publicUrl) {
      console.log(pc.dim(`  public URL     ${cfg.publicUrl}`));
    }
    console.log(pc.dim(`  attach with:   friday attach <${SERVICES.join("|")}>`));
  },
});
