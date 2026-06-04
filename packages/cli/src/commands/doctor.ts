import { defineCommand } from "citty";
import pc from "picocolors";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_PATH,
  DATA_DIR,
  ENV_PATH,
  FRIDAY_PG_CONSTANTS,
  LOGS_DIR,
  SOUL_PATH,
  closeDb,
  getDb,
  loadFridayConfig,
  probePostgresHealth,
  schema,
} from "@friday/shared";
import { DaemonClient } from "../lib/api.js";
import { BANNER } from "../lib/branding.js";
import { launchdJobStatus } from "./status.js";
import { FRIDAY_FNM_BIN_ENV, FRIDAY_LAUNCHD_LABEL, plistPath } from "../lib/launchd.js";
import { currentLink } from "../lib/install-paths.js";

type Section = "Dependencies" | "Configuration" | "Runtime" | "PostgreSQL";
type Status = "ok" | "warn" | "fail";

interface DoctorCheck {
  section: Section;
  label: string;
  status: Status;
  value: string;
  hint?: string;
}

const SECTIONS: Section[] = ["Dependencies", "Configuration", "Runtime", "PostgreSQL"];

// Box dimensions. 68 columns matches the docs/architecture diagrams and most
// 80-column terminals with comfortable margin. Adjust here only; the renderer
// derives everything else from these.
const WIDTH = 68;
const INNER = WIDTH - 2; // 66
const LABEL_COL = 23;
const VALUE_COL = INNER - 2 - 1 - 1 - LABEL_COL; // 39: 2 indent + 1 icon + 1 space + label + value = INNER

export const doctorCommand = defineCommand({
  meta: { name: "doctor", description: "Check system health" },
  async run() {
    console.log(BANNER);
    if (existsSync(ENV_PATH)) loadFridayConfig();

    const checks = await collectChecks();

    for (const section of SECTIONS) {
      const items = checks.filter((c) => c.section === section);
      if (items.length === 0) continue;
      for (const line of renderSection(section, items)) console.log(line);
      console.log();
    }

    const failed = checks.filter((c) => c.status === "fail").length;
    const passed = checks.filter((c) => c.status === "ok").length;
    console.log(pc.bold(`${passed}/${checks.length} checks passed.`));
    // Close the pg pool so the process exits immediately. Without this, the
    // pool's `idleTimeoutMillis` (30s) keeps idle TCP sockets alive and Node
    // can't drain the event loop — `friday doctor` appears to hang after
    // printing the summary.
    await closeDb();
    if (failed > 0) process.exit(1);
  },
});

// ============================================================================
// Check collection
// ============================================================================

async function collectChecks(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // ---- Dependencies --------------------------------------------------------

  // fnm: prefer the absolute path baked into the plist (the launchd-supervised
  // boot path). Fall back to $PATH for the dev/CLI invocation case. Either way
  // we assert it's a real executable, not just present-on-disk.
  const fnmFromPlist = readFnmBinFromPlist();
  const fnmFromPath = (() => {
    const r = spawnSync("which", ["fnm"], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : "";
  })();
  const fnmAbs = fnmFromPlist ?? fnmFromPath ?? "";
  const fnmOk = isExecutable(fnmAbs);
  checks.push({
    section: "Dependencies",
    label: "fnm",
    status: fnmOk ? "ok" : "fail",
    value: fnmOk ? displayPath(fnmAbs) : "missing",
    hint: fnmOk ? undefined : "install with `brew install fnm`",
  });

  // node version: .node-version pin inside the install tree
  const link = currentLink();
  const installOk = existsSync(link);
  const nodeVersionFile = installOk ? join(link, ".node-version") : "";
  const pinOk = installOk && existsSync(nodeVersionFile);
  const pinValue = (() => {
    if (!pinOk) return "missing";
    try {
      return readFileSync(nodeVersionFile, "utf8").trim();
    } catch {
      return "unreadable";
    }
  })();
  checks.push({
    section: "Dependencies",
    label: "node version",
    status: pinOk ? "ok" : "fail",
    value: pinOk ? `pinned (${pinValue})` : "missing",
    hint: pinOk ? undefined : "re-run `friday update` to repopulate the install tree",
  });

  // claude CLI
  const claudeOk = spawnSync("which", ["claude"], { encoding: "utf8" }).status === 0;
  checks.push({
    section: "Dependencies",
    label: "claude CLI",
    status: claudeOk ? "ok" : "fail",
    value: claudeOk ? "installed" : "missing",
    hint: claudeOk
      ? undefined
      : "install via `curl -fsSL https://claude.ai/install.sh | bash` or `brew install --cask claude-code`",
  });

  // gh CLI
  const ghOk = spawnSync("which", ["gh"], { encoding: "utf8" }).status === 0;
  checks.push({
    section: "Dependencies",
    label: "gh CLI",
    status: ghOk ? "ok" : "fail",
    value: ghOk ? "installed" : "missing",
    hint: ghOk ? undefined : "install with `brew install gh`",
  });

  // postgres: postgresql@18 is keg-only, so psql often isn't on PATH even
  // though the formula is installed. Prefer `brew list postgresql@18` (which
  // reports whether the keg is installed regardless of linking) and fall back
  // to `which psql` for non-brew installs.
  const psqlOk =
    spawnSync("brew", ["list", "postgresql@18"], { encoding: "utf8" }).status === 0 ||
    spawnSync("which", ["psql"], { encoding: "utf8" }).status === 0;
  checks.push({
    section: "Dependencies",
    label: "postgres",
    status: psqlOk ? "ok" : "fail",
    value: psqlOk ? "installed" : "missing",
    hint: psqlOk ? undefined : "install with `brew install postgresql@18`",
  });

  // cloudflared (warn if missing — only required for the public tunnel)
  const cflOk = spawnSync("which", ["cloudflared"], { encoding: "utf8" }).status === 0;
  checks.push({
    section: "Dependencies",
    label: "cloudflared",
    status: cflOk ? "ok" : "warn",
    value: cflOk ? "installed" : "missing",
    hint: cflOk ? undefined : "only required for the public tunnel — `brew install cloudflared`",
  });

  // install tree
  checks.push({
    section: "Dependencies",
    label: "install tree",
    status: installOk ? "ok" : "fail",
    value: installOk ? displayPath(link) : "missing",
    hint: installOk
      ? undefined
      : "install via `curl -fsSL https://raw.githubusercontent.com/sethvoltz/friday/main/install.sh | bash`",
  });

  // ---- Configuration -------------------------------------------------------

  const dataDirOk = existsSync(DATA_DIR);
  checks.push({
    section: "Configuration",
    label: "data dir",
    status: dataDirOk ? "ok" : "fail",
    value: displayPath(DATA_DIR),
    hint: dataDirOk ? undefined : "run `friday setup` to create",
  });
  checks.push({
    section: "Configuration",
    label: "config",
    status: existsSync(CONFIG_PATH) ? "ok" : "fail",
    value: displayPath(CONFIG_PATH),
  });
  checks.push({
    section: "Configuration",
    label: "env",
    status: existsSync(ENV_PATH) ? "ok" : "fail",
    value: displayPath(ENV_PATH),
  });
  checks.push({
    section: "Configuration",
    label: "SOUL.md",
    status: existsSync(SOUL_PATH) ? "ok" : "fail",
    value: displayPath(SOUL_PATH),
  });

  // primary account
  let accountOk = false;
  try {
    const db = getDb();
    const users = await db.select().from(schema.users).limit(1);
    accountOk = users.length > 0;
  } catch {
    // db not migrated yet — handled below by the PostgreSQL section
  }
  checks.push({
    section: "Configuration",
    label: "primary account",
    status: accountOk ? "ok" : "fail",
    value: accountOk ? "present" : "missing",
    hint: accountOk ? undefined : "run `friday setup`",
  });

  // Cloudflare Tunnel token — informational; tunnel is opt-in
  const tunnelTokenSet = !!loadFridayConfig().cloudflareTunnelToken;
  checks.push({
    section: "Configuration",
    label: "cloudflare token",
    status: tunnelTokenSet ? "ok" : "warn",
    value: tunnelTokenSet ? "present" : "absent",
    hint: tunnelTokenSet
      ? undefined
      : "public tunnel disabled — `friday setup --cloudflare` to enable",
  });

  // ---- Runtime -------------------------------------------------------------

  checks.push({
    section: "Runtime",
    label: "logs dir",
    status: existsSync(LOGS_DIR) ? "ok" : "fail",
    value: displayPath(LOGS_DIR),
  });

  const fridayJob = launchdJobStatus(FRIDAY_LAUNCHD_LABEL);
  checks.push({
    section: "Runtime",
    label: "friday-supervisor",
    status: fridayJob.loaded ? "ok" : "fail",
    value: `(launchd: ${FRIDAY_LAUNCHD_LABEL})`,
    hint: fridayJob.loaded ? undefined : "run `friday start`",
  });

  // Plist exec target audit — show only when broken, so the steady-state
  // doctor stays tight. A broken target crash-loops the supervisor without a
  // clear cause; surfacing it here points the operator at the right fix.
  const pp = plistPath();
  if (existsSync(pp)) {
    const parsed = readPlistJson(pp);
    const programArg0 = parsed?.ProgramArguments?.[0];
    if (!isExecutable(programArg0)) {
      checks.push({
        section: "Runtime",
        label: "plist exec",
        status: "fail",
        value: programArg0 ?? "<unset>",
        hint: "re-run `friday start` to rewrite the plist",
      });
    }
  }

  // daemon reachable (localhost)
  const client = new DaemonClient();
  const daemonReachable = await client.ping();
  checks.push({
    section: "Runtime",
    label: "daemon",
    status: daemonReachable ? "ok" : "fail",
    value: daemonReachable ? "reachable (localhost)" : "unreachable",
    hint: daemonReachable ? undefined : "run `friday start`",
  });

  // zero-cache reachable
  const zeroReachable = await tcpReachable("127.0.0.1", 4848, 500);
  checks.push({
    section: "Runtime",
    label: "zero-cache",
    status: zeroReachable ? "ok" : "fail",
    value: zeroReachable ? "reachable (localhost:4848)" : "unreachable",
    hint: zeroReachable ? undefined : "run `friday start`",
  });

  // ---- PostgreSQL ----------------------------------------------------------

  try {
    const pg = await probePostgresHealth();
    const { FRIDAY_DB, FRIDAY_ROLE, FRIDAY_PUBLICATION } = FRIDAY_PG_CONSTANTS;
    if (!pg.reachable) {
      checks.push({
        section: "PostgreSQL",
        label: "daemon",
        status: "fail",
        value: "unreachable",
        hint: pg.reachableReason ?? "`brew services start postgresql@18`",
      });
    } else {
      checks.push({
        section: "PostgreSQL",
        label: "daemon",
        status: "ok",
        value: "reachable (localhost)",
      });
      checks.push({
        section: "PostgreSQL",
        label: "role",
        status: pg.roleExists ? "ok" : "fail",
        value: pg.roleExists ? FRIDAY_ROLE : "missing",
        hint: pg.roleExists ? undefined : "run `friday setup`",
      });
      checks.push({
        section: "PostgreSQL",
        label: "database",
        status: pg.databaseExists ? "ok" : "fail",
        value: pg.databaseExists ? FRIDAY_DB : "missing",
        hint: pg.databaseExists ? undefined : "run `friday setup`",
      });
      checks.push({
        section: "PostgreSQL",
        label: "migrations",
        status: pg.migrationsAtHead ? "ok" : "fail",
        value: pg.migrationsAtHead
          ? `at head (${pg.migrationsApplied}/${pg.migrationsExpected})`
          : `${pg.migrationsApplied}/${pg.migrationsExpected} applied`,
        hint: pg.migrationsAtHead ? undefined : "run `friday setup` to apply pending migrations",
      });
      checks.push({
        section: "PostgreSQL",
        label: "publication",
        status: pg.publicationExists ? "ok" : "fail",
        value: pg.publicationExists ? FRIDAY_PUBLICATION : "missing",
        hint: pg.publicationExists ? undefined : "run `friday setup`",
      });
      checks.push({
        section: "PostgreSQL",
        label: "wal_level",
        status: pg.walLevelLogical ? "ok" : "fail",
        value: pg.walLevelLogical ? "logical" : (pg.walLevelActual ?? "unknown"),
        hint: pg.walLevelLogical
          ? undefined
          : "run `friday setup`, then `brew services restart postgresql@18`",
      });
      // ZERO_AUTH_SECRET is sourced via the postgres probe but conceptually
      // sits in Configuration; push it there.
      checks.push({
        section: "Configuration",
        label: "ZERO_AUTH_SECRET",
        status: pg.zeroAuthSecretPresent ? "ok" : "fail",
        value: pg.zeroAuthSecretPresent ? "present" : "missing",
        hint: pg.zeroAuthSecretPresent ? undefined : "run `friday setup` to generate the secret",
      });
    }
  } catch (err) {
    checks.push({
      section: "PostgreSQL",
      label: "health probe",
      status: "fail",
      value: "failed",
      hint: err instanceof Error ? err.message : String(err),
    });
  }

  // ---- Stale-state warnings -----------------------------------------------
  // These were the existing doctor's "should-be-derived" warnings; surface
  // them as warn-status rows tied to the right section.

  if (existsSync(ENV_PATH)) {
    try {
      const envText = readFileSync(ENV_PATH, "utf8");
      if (/^ZERO_MUTATE_URL=/m.test(envText)) {
        checks.push({
          section: "Configuration",
          label: "ZERO_MUTATE_URL",
          status: "warn",
          value: "stale in .env",
          hint: "remove this line — the supervisor exports it dynamically at spawn time",
        });
      }
    } catch {
      // ignore
    }
  }

  try {
    const cfgRaw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
    const stale: string[] = [];
    if ("daemonPort" in cfgRaw) stale.push("daemonPort");
    if ("dashboardPort" in cfgRaw) stale.push("dashboardPort");
    if ("daemonBaseUrl" in cfgRaw) stale.push("daemonBaseUrl");
    if ("dashboardBaseUrl" in cfgRaw) stale.push("dashboardBaseUrl");
    if (stale.length > 0) {
      checks.push({
        section: "Configuration",
        label: "config.json fields",
        status: "warn",
        value: `stale: ${stale.join(", ")}`,
        hint: "remove from config.json — defaults resolve via PROD_*_PORT constants",
      });
    }
  } catch {
    // ignore missing/malformed config — covered by the "config" check above
  }

  // Orphaned zero-cache replica WAL — large WAL with no live zero-cache
  // suggests an unclean previous shutdown that the auto-reset loop hasn't
  // re-checkpointed.
  const walPath = join(DATA_DIR, "zero", "replica.db-wal");
  if (existsSync(walPath)) {
    try {
      const walSize = statSync(walPath).size;
      if (walSize > 0 && !zeroReachable) {
        checks.push({
          section: "Runtime",
          label: "zero-cache WAL",
          status: "warn",
          value: `orphaned (${walSize} bytes)`,
          hint: "unclean previous shutdown — `rm -rf ~/.friday/zero/` to force a fresh sync",
        });
      }
    } catch {
      // ignore
    }
  }

  return checks;
}

// ============================================================================
// Rendering
// ============================================================================

function renderSection(section: Section, items: DoctorCheck[]): string[] {
  const ok = items.filter((c) => c.status === "ok").length;
  const lines: string[] = [];
  lines.push(renderTopBorder(section, ok, items.length));
  lines.push(renderBlankLine());
  for (const item of items) {
    lines.push(renderCheckLine(item));
    if (item.hint) {
      for (const wrapped of wrapText(item.hint, INNER - 6)) {
        lines.push(renderHintLine(wrapped));
      }
    }
  }
  lines.push(renderBlankLine());
  lines.push(renderBottomBorder());
  return lines;
}

function renderTopBorder(title: string, ok: number, total: number): string {
  // ╒═ <title> ( ok / total ) ═════════════════════════════════════╕
  const titlePart = ` ${title} ( ${ok} / ${total} ) `;
  const fillCount = WIDTH - 1 - 1 - titlePart.length - 1; // ╒ + ═ + titlePart + ═… + ╕
  return pc.bold(`╒═${titlePart}${"═".repeat(Math.max(0, fillCount))}╕`);
}

function renderBottomBorder(): string {
  return `└${"─".repeat(INNER)}┘`;
}

function renderBlankLine(): string {
  return `│${" ".repeat(INNER)}│`;
}

function renderCheckLine(check: DoctorCheck): string {
  const icon = statusIcon(check.status);
  const labelArea = padTo(check.label, LABEL_COL);
  const valueArea = padTo(check.value, VALUE_COL);
  return `│  ${icon} ${labelArea}${valueArea}│`;
}

function renderHintLine(hint: string): string {
  // │      - <hint padded to (INNER - 6)>│
  const prefix = "    - ";
  const body = padTo(hint, INNER - prefix.length);
  return `│${prefix}${pc.dim(body)}│`;
}

function statusIcon(status: Status): string {
  switch (status) {
    case "ok":
      return pc.green("✔");
    case "warn":
      return pc.yellow("⚠");
    case "fail":
      return pc.red("✘");
  }
}

/** Pad `s` with spaces on the right to `width`. Truncates with an ellipsis
 *  if `s` exceeds `width` so the box edge stays aligned. */
function padTo(s: string, width: number): string {
  if (s.length === width) return s;
  if (s.length > width) {
    if (width <= 1) return s.slice(0, width);
    return s.slice(0, width - 1) + "…";
  }
  return s + " ".repeat(width - s.length);
}

/** Word-wrap to a max width. Tiny implementation — splits on whitespace,
 *  doesn't preserve runs of spaces or break long single tokens. */
function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length + 1 + w.length <= width || !cur) {
      cur = cur ? `${cur} ${w}` : w;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Replace `DATA_DIR/X` with `@data/X` and `HOME/X` with `~/X`. The data dir
 *  itself stays as `~/.friday` rather than collapsing to `@data` (a bare
 *  `@data` would be confusing as a value). */
function displayPath(abs: string | undefined | null): string {
  if (!abs) return "";
  const home = homedir();
  if (abs.startsWith(DATA_DIR + "/")) return "@data" + abs.slice(DATA_DIR.length);
  if (abs.startsWith(home + "/")) return "~" + abs.slice(home.length);
  if (abs === home) return "~";
  return abs;
}

// ============================================================================
// Plist + executable probes (used by both Dependencies and Runtime sections)
// ============================================================================

interface ParsedPlist {
  ProgramArguments?: string[];
  EnvironmentVariables?: Record<string, string>;
}

/** Parse a `.plist` file via macOS's stock `plutil -convert json -o - <path>`.
 *  Returns null on any failure — the caller treats that as "can't audit". */
function readPlistJson(path: string): ParsedPlist | null {
  const r = spawnSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    return JSON.parse(r.stdout) as ParsedPlist;
  } catch {
    return null;
  }
}

function readFnmBinFromPlist(): string | null {
  const pp = plistPath();
  if (!existsSync(pp)) return null;
  const parsed = readPlistJson(pp);
  return parsed?.EnvironmentVariables?.[FRIDAY_FNM_BIN_ENV] ?? null;
}

/** True if `path` is a non-empty string pointing at an existing file with
 *  any user/group/other execute bit set. */
function isExecutable(path: string | undefined | null): boolean {
  if (!path) return false;
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** TCP-connect with timeout. Used as a cheap liveness probe for zero-cache;
 *  a full WS handshake would be more accurate but the open port is sufficient
 *  signal for the doctor's purposes. */
async function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
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
