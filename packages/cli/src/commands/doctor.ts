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
  getDb,
  schema,
} from "@friday/shared";
import { DaemonClient } from "../lib/api.js";

export const doctorCommand = defineCommand({
  meta: { name: "doctor", description: "Check system health" },
  async run() {
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

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
    for (const c of checks) {
      if (c.ok) {
        okCount++;
        console.log(`  ${pc.green("✓")} ${c.name}`);
      } else {
        console.log(`  ${pc.red("✗")} ${c.name}${c.detail ? pc.dim(` — ${c.detail}`) : ""}`);
      }
    }
    console.log();
    console.log(
      pc.bold(`${okCount}/${checks.length} checks passed.`),
    );
    if (okCount < checks.length) process.exit(1);
  },
});

function check(name: string, ok: boolean, detail?: string) {
  return { name, ok, detail };
}
