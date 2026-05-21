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
 * cloudflared is installed as its own user launch agent by
 * `friday setup --cloudflare` (`cloudflared service install <TOKEN>`),
 * which writes `~/Library/LaunchAgents/com.cloudflare.cloudflared.plist`
 * with `RunAtLoad: true` + `KeepAlive`. Once installed, launchd brings
 * it up automatically — `friday start` doesn't need to touch it.
 */

function brewFridayInstalled(): boolean {
  const r = spawnSync("brew", ["list", "friday"], { stdio: "ignore" });
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

    // cloudflared is supervised independently via its own launchd job
    // (`com.cloudflare.cloudflared`), installed by `friday setup --cloudflare`.
    // RunAtLoad + KeepAlive bring it up automatically; nothing to do here
    // beyond reminding the user when they haven't run setup yet.
    if (!process.env.CLOUDFLARE_TUNNEL_TOKEN) {
      console.log(
        pc.dim(`  · no public tunnel — ${pc.cyan("friday setup --cloudflare")} to enable`),
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
