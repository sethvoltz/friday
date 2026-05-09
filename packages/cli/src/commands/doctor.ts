import { defineCommand } from "citty";
import pc from "picocolors";
import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  CONFIG_PATH,
  DATA_DIR,
  DB_PATH,
  ENV_PATH,
  LOGS_DIR,
  SOUL_PATH,
  ensureFridayEnv,
  getDb,
  schema,
} from "@friday/shared";
import { DaemonClient } from "../lib/api.js";
import { BANNER } from "../lib/branding.js";

export const doctorCommand = defineCommand({
  meta: { name: "doctor", description: "Check system health" },
  async run() {
    console.log(BANNER);
    if (existsSync(ENV_PATH)) ensureFridayEnv();
    const checks: Array<{
      name: string;
      ok: boolean;
      warn?: boolean;
      detail?: string;
    }> = [];

    checks.push(check(`data dir ${DATA_DIR}`, existsSync(DATA_DIR)));
    checks.push(check(`config ${CONFIG_PATH}`, existsSync(CONFIG_PATH)));
    checks.push(check(`env ${ENV_PATH}`, existsSync(ENV_PATH)));
    checks.push(check(`db ${DB_PATH}`, existsSync(DB_PATH)));
    checks.push(check(`SOUL.md ${SOUL_PATH}`, existsSync(SOUL_PATH)));
    checks.push(check(`logs dir ${LOGS_DIR}`, existsSync(LOGS_DIR)));

    // Account
    let accountOk = false;
    try {
      const db = getDb();
      const users = db.select().from(schema.users).limit(1).all();
      accountOk = users.length > 0;
    } catch {
      // db not migrated yet
    }
    checks.push(check("primary account exists", accountOk, accountOk ? undefined : "run `friday setup`"));

    // tmux
    const tmux = spawnSync("which", ["tmux"], { encoding: "utf8" });
    checks.push(check("tmux installed", tmux.status === 0));

    // claude
    const claude = spawnSync("which", ["claude"], { encoding: "utf8" });
    checks.push(check("claude CLI installed", claude.status === 0));

    // gh
    const gh = spawnSync("which", ["gh"], { encoding: "utf8" });
    checks.push(check("gh CLI installed", gh.status === 0));

    // Cloudflare Tunnel — token + binary. Token-set-but-binary-missing is
    // a hard failure (user opted in); everything else is informational.
    const tunnelTokenSet = !!process.env.CLOUDFLARE_TUNNEL_TOKEN;
    const cloudflaredOk =
      spawnSync("which", ["cloudflared"], { encoding: "utf8" }).status === 0;
    if (tunnelTokenSet) {
      checks.push(check("Cloudflare Tunnel token", true));
      checks.push(
        check(
          "cloudflared binary",
          cloudflaredOk,
          cloudflaredOk
            ? undefined
            : "token configured but cloudflared not on PATH — `brew install cloudflared`",
        ),
      );
    } else {
      checks.push(
        warn(
          "Cloudflare Tunnel token",
          "not configured — public tunnel disabled (run `friday setup --cloudflare` to enable)",
        ),
      );
      if (!cloudflaredOk) {
        checks.push(
          warn(
            "cloudflared binary",
            "not installed — only required for public tunnel",
          ),
        );
      } else {
        checks.push(check("cloudflared binary", true));
      }
    }

    // daemon reachable
    const client = new DaemonClient();
    const reachable = await client.ping();
    checks.push(check("daemon reachable (localhost)", reachable, reachable ? undefined : "not running — `friday start`"));

    // disk
    try {
      const st = statSync(DATA_DIR);
      checks.push(check(`data dir is ${st.mode.toString(8)}`, true));
    } catch {
      // ignore
    }

    let okCount = 0;
    let failCount = 0;
    for (const c of checks) {
      const detail = c.detail ? pc.dim(` — ${c.detail}`) : "";
      if (c.ok) {
        okCount++;
        console.log(`  ${pc.green("✓")} ${c.name}`);
      } else if (c.warn) {
        console.log(`  ${pc.yellow("⚠")} ${c.name}${detail}`);
      } else {
        failCount++;
        console.log(`  ${pc.red("✗")} ${c.name}${detail}`);
      }
    }
    console.log();
    console.log(
      pc.bold(`${okCount}/${checks.length} checks passed.`),
    );
    if (failCount > 0) process.exit(1);
  },
});

function check(name: string, ok: boolean, detail?: string) {
  return { name, ok, detail };
}

function warn(name: string, detail?: string) {
  return { name, ok: false, warn: true, detail };
}
