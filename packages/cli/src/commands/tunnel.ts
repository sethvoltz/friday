/**
 * `friday tunnel up|down|status` — the explicit serve-intent flip for the
 * Cloudflare tunnel (FRI-166).
 *
 * The cloudflared launch agent is reconciled declaratively against
 * `config.json` `tunnel.serve` (serve-intent) AND token presence in the vault
 * — see `lib/cloudflared.ts`. This command is the operator's lever on that
 * intent:
 *   - `up`   → set serve-intent on, install/run the agent now (the cutover
 *              step after a migration restore, which leaves it dark).
 *   - `down` → set serve-intent off, tear the agent down now (the pre-cutover
 *              step on the SOURCE machine to avoid two connectors on one
 *              hostname — split-brain).
 *   - `status` → report intent, token presence, agent load state, public URL.
 *
 * `friday setup --cloudflare` also sets serve-intent on (it's the configure
 * path); this command flips intent without re-prompting for the token.
 */

import { defineCommand } from "citty";
import pc from "picocolors";
import { loadConfig, loadFridayConfig, writeConfig } from "@friday/shared";
import { cloudflaredLoaded, reconcileTunnel } from "../lib/cloudflared.js";

const upCommand = defineCommand({
  meta: {
    name: "up",
    description:
      "Serve the Cloudflare tunnel from this machine (set serve-intent + start the agent).",
  },
  async run() {
    const token = loadFridayConfig().cloudflareTunnelToken;
    if (!token) {
      console.error(pc.red("✗ no tunnel token in the vault."));
      console.error(`  run ${pc.cyan("friday setup --cloudflare")} to configure one first.`);
      process.exit(1);
    }

    const cfg = loadConfig();
    cfg.tunnel = { ...cfg.tunnel, serve: true };
    writeConfig(cfg);

    const res = reconcileTunnel({ serve: true, token });
    if (res.skipped) {
      console.log(pc.yellow(`  ${res.detail}`));
      process.exit(1);
    }
    if (!res.ok) {
      // installCloudflared already printed the failure detail.
      process.exit(1);
    }
    const url = cfg.publicUrl ? `  ${pc.cyan(cfg.publicUrl)}` : "";
    console.log(pc.green(`✓ tunnel serving${url}`));
  },
});

const downCommand = defineCommand({
  meta: {
    name: "down",
    description:
      "Stop serving the Cloudflare tunnel from this machine (clear serve-intent + remove the agent).",
  },
  async run() {
    const cfg = loadConfig();
    cfg.tunnel = { ...cfg.tunnel, serve: false };
    writeConfig(cfg);

    // Token stays in the vault — `down` is about serve-intent, not deleting
    // the secret. serve:false → reconcile tears the agent down if loaded.
    reconcileTunnel({ serve: false, token: loadFridayConfig().cloudflareTunnelToken });
    console.log(pc.green("✓ tunnel stopped (serve-intent off; token kept in vault)"));
  },
});

const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show the tunnel's serve-intent, token, agent state, and public URL.",
  },
  async run() {
    const cfg = loadConfig();
    const token = loadFridayConfig().cloudflareTunnelToken;
    const serve = cfg.tunnel?.serve === true;
    const loaded = cloudflaredLoaded();

    console.log(pc.bold("Friday tunnel"));
    console.log(`  serve-intent  ${serve ? pc.green("on") : pc.dim("off")}`);
    console.log(`  token         ${token ? pc.green("present") : pc.dim("absent")}`);
    console.log(`  agent         ${loaded ? pc.green("loaded") : pc.dim("not loaded")}`);
    if (cfg.publicUrl) console.log(`  public URL    ${pc.cyan(cfg.publicUrl)}`);

    if (serve && token && !loaded) {
      console.log(
        pc.yellow(`  ⚠ serve-intent on but agent not loaded — run ${pc.cyan("friday start")}.`),
      );
    } else if (!serve && loaded) {
      console.log(
        pc.yellow(`  ⚠ agent loaded but serve-intent off — run ${pc.cyan("friday tunnel down")}.`),
      );
    } else if (serve && !token) {
      console.log(
        pc.yellow(
          `  ⚠ serve-intent on but no token — run ${pc.cyan("friday setup --cloudflare")}.`,
        ),
      );
    }
  },
});

export const tunnelCommand = defineCommand({
  meta: {
    name: "tunnel",
    description: "Manage the Cloudflare tunnel serve-intent (up / down / status).",
  },
  subCommands: {
    up: upCommand,
    down: downCommand,
    status: statusCommand,
  },
});
