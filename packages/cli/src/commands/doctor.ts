import { defineCommand } from "citty";
import pc from "picocolors";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  CONFIG_PATH,
  DATA_DIR,
  ENV_PATH,
  FRIDAY_PG_CONSTANTS,
  LOGS_DIR,
  SOUL_PATH,
  ensureFridayEnv,
  getDb,
  probePostgresHealth,
  schema,
} from "@friday/shared";
import { DaemonClient } from "../lib/api.js";
import { BANNER } from "../lib/branding.js";
import { launchdJobStatus } from "./status.js";

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
    checks.push(check(`SOUL.md ${SOUL_PATH}`, existsSync(SOUL_PATH)));
    checks.push(check(`logs dir ${LOGS_DIR}`, existsSync(LOGS_DIR)));

    // Account
    let accountOk = false;
    try {
      const db = getDb();
      const users = await db.select().from(schema.users).limit(1);
      accountOk = users.length > 0;
    } catch {
      // db not migrated yet
    }
    checks.push(check("primary account exists", accountOk, accountOk ? undefined : "run `friday setup`"));

    // launchd supervisor (homebrew.mxcl.friday). Replaces the pre-FRI-88
    // tmux check — the supervised set lives in one launchd job now, not
    // a tmux session per service.
    const fridayJob = launchdJobStatus("homebrew.mxcl.friday");
    checks.push(
      check(
        "friday-supervisor (launchd: homebrew.mxcl.friday)",
        fridayJob.loaded,
        fridayJob.loaded
          ? undefined
          : "not loaded — `brew services start friday` (or `friday start`). Install via `brew install sethvoltz/friday/friday` if you haven't yet.",
      ),
    );

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

    // Postgres (ADR-023). All sub-checks roll into one health probe.
    try {
      const pg = await probePostgresHealth();
      const { FRIDAY_DB, FRIDAY_ROLE, FRIDAY_PUBLICATION } = FRIDAY_PG_CONSTANTS;
      if (!pg.reachable) {
        checks.push(
          check(
            "Postgres reachable",
            false,
            pg.reachableReason ?? "pg_isready failed — `brew services start postgresql@18`",
          ),
        );
      } else {
        checks.push(check("Postgres reachable", true));
        checks.push(
          check(
            `Postgres role ${FRIDAY_ROLE}`,
            pg.roleExists,
            pg.roleExists ? undefined : "run `friday setup`",
          ),
        );
        checks.push(
          check(
            `Postgres database ${FRIDAY_DB}`,
            pg.databaseExists,
            pg.databaseExists ? undefined : "run `friday setup`",
          ),
        );
        checks.push(
          check(
            `Postgres migrations at head (${pg.migrationsApplied}/${pg.migrationsExpected})`,
            pg.migrationsAtHead,
            pg.migrationsAtHead
              ? undefined
              : "run `friday setup` to apply pending migrations",
          ),
        );
        checks.push(
          check(
            `Postgres publication ${FRIDAY_PUBLICATION}`,
            pg.publicationExists,
            pg.publicationExists ? undefined : "run `friday setup`",
          ),
        );
        checks.push(
          check(
            "ZERO_AUTH_SECRET present",
            pg.zeroAuthSecretPresent,
            pg.zeroAuthSecretPresent
              ? undefined
              : "run `friday setup` to generate the secret",
          ),
        );
        checks.push(
          check(
            `Postgres wal_level=logical (Zero replication)`,
            pg.walLevelLogical,
            pg.walLevelLogical
              ? undefined
              : `actual: ${pg.walLevelActual ?? "unknown"} — run \`friday setup\` then \`brew services restart postgresql@18\``,
          ),
        );
      }
    } catch (err) {
      checks.push(
        check(
          "Postgres health probe",
          false,
          err instanceof Error ? err.message : String(err),
        ),
      );
    }

    // daemon reachable
    const client = new DaemonClient();
    const reachable = await client.ping();
    checks.push(check("daemon reachable (localhost)", reachable, reachable ? undefined : "not running — `friday start`"));

    // zero-cache reachable (Phase 2 / ADR-024). zero-cache binds
    // ws://127.0.0.1:4848 by default; treat a TCP-open as "alive". A more
    // thorough health probe (replication slot caught up, etc.) lives in
    // the zero-cache process logs.
    const zeroReachable = await tcpReachable("127.0.0.1", 4848, 500);
    checks.push(
      check(
        "zero-cache reachable (localhost:4848)",
        zeroReachable,
        zeroReachable ? undefined : "not running — `friday start zero-cache`",
      ),
    );

    // Stale runtime-state warnings (FRI-88 Q11). These don't fail the
    // doctor — they're "should-be-derived" values that an operator may
    // have inherited from pre-FRI-83 or pre-FRI-88 setup. Each warning
    // points at the canonical source of truth.

    // 1. ZERO_MUTATE_URL in .env (now spawn-time-only via supervisor)
    if (existsSync(ENV_PATH)) {
      try {
        const envText = readFileSync(ENV_PATH, "utf8");
        if (/^ZERO_MUTATE_URL=/m.test(envText)) {
          checks.push(
            warn(
              "stale ZERO_MUTATE_URL in ~/.friday/.env",
              "remove this line — the supervisor exports it dynamically at spawn time (FRI-83 follow-up). Stale value will be ignored but is misleading.",
            ),
          );
        }
      } catch {
        // ignore
      }
    }

    // 2. daemonPort / dashboardPort in config.json (now optional)
    try {
      const cfgRaw = JSON.parse(
        readFileSync(CONFIG_PATH, "utf8"),
      ) as Record<string, unknown>;
      const staleFields: string[] = [];
      if ("daemonPort" in cfgRaw) staleFields.push("daemonPort");
      if ("dashboardPort" in cfgRaw) staleFields.push("dashboardPort");
      if ("daemonBaseUrl" in cfgRaw) staleFields.push("daemonBaseUrl");
      if ("dashboardBaseUrl" in cfgRaw) staleFields.push("dashboardBaseUrl");
      if (staleFields.length > 0) {
        checks.push(
          warn(
            `stale field(s) in ~/.friday/config.json: ${staleFields.join(", ")}`,
            "these fields are now optional and resolve via PROD_*_PORT constants. Remove unless you intentionally need an override.",
          ),
        );
      }
    } catch {
      // ignore missing/malformed config (other checks cover that case)
    }

    // 3. Orphaned zero-cache replica WAL — large WAL with no live
    // zero-cache process suggests an unclean previous shutdown that
    // the auto-reset loop hasn't re-checkpointed. Not a hard failure;
    // operator can `rm -rf ~/.friday/zero/` to force a fresh sync from
    // Postgres logical replication.
    const walPath = join(DATA_DIR, "zero", "replica.db-wal");
    if (existsSync(walPath)) {
      try {
        const walSize = statSync(walPath).size;
        if (walSize > 0 && !zeroReachable) {
          checks.push(
            warn(
              `orphaned zero-cache WAL (${walSize} bytes, no live zero-cache)`,
              "unclean previous shutdown — `rm -rf ~/.friday/zero/` to force a fresh sync from Postgres on next start.",
            ),
          );
        }
      } catch {
        // ignore
      }
    }

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

/** TCP-connect with timeout. Used as a cheap liveness probe for
 *  zero-cache; a full WS handshake would be more accurate but the open
 *  port is sufficient signal for the doctor's purposes. */
async function tcpReachable(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const { Socket } = await import("node:net");
  return new Promise<boolean>((resolve) => {
    const sock = new Socket();
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}
