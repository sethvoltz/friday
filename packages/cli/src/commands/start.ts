import { defineCommand } from "citty";
import pc from "picocolors";
import {
  ensureFridayEnv,
  loadConfig,
  resolveDaemonPort,
  resolveDashboardPort,
  SERVICES,
} from "@friday/shared";
import * as launchd from "../lib/launchd.js";
import { currentLink } from "../lib/install-paths.js";

/**
 * `friday start` — thin alias over `launchctl bootstrap` (FRI-146 /
 * ADR-034).
 *
 * Supervision lives in launchd via a plist Friday writes directly
 * (label `com.sethvoltz.friday`), bootstrapped via `launchctl bootstrap`.
 * The plist runs `friday-supervisor` through `fnm exec`, which forks
 * daemon + dashboard + zero-cache as children with proper process-group
 * cascade-stop semantics. The tmux era is over.
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

export const startCommand = defineCommand({
  meta: {
    name: "start",
    description:
      "Start Friday's prod stack (launchd-supervised). For dev hot-reload, use `pnpm dev:daemon` / `pnpm dev:dashboard`.",
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
      console.error(pc.red(`single-service operations not supported under launchd supervision.`));
      console.error(`  the supervisor owns the whole stack atomically; bounce it with:`);
      console.error(`    ${pc.cyan("friday restart")}    # whole stack`);
      console.error(`  per-service IPC is an explicit follow-up ticket — see ADR-028.`);
      process.exit(1);
    }

    ensureFridayEnv();

    // Bootstrap (or kickstart, if already loaded) the supervisor's launchd
    // job from the `current` install tree.
    console.log(pc.green("starting friday stack via launchd"));
    try {
      if (launchd.isBootstrapped()) {
        launchd.kickstart();
      } else {
        launchd.bootstrap(currentLink());
      }
    } catch (err) {
      console.error(pc.red(`failed to start friday: ${err instanceof Error ? err.message : err}`));
      console.error(
        `  not installed? ${pc.cyan("curl -fsSL https://raw.githubusercontent.com/sethvoltz/friday/main/install.sh | bash")}`,
      );
      process.exit(1);
    }

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
