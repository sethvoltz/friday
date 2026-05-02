import { existsSync, readFileSync, accessSync, constants } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { defineCommand } from "citty";
import {
  FRIDAY_DIR,
  CONFIG_PATH,
  ENV_PATH,
  BEADS_DIR,
  loadConfig,
} from "@friday/shared";
import { readPid, isRunning } from "../services.js";
import { BANNER, dim, bold, green, yellow, red } from "../branding.js";

export interface CheckResult {
  status: "pass" | "warn" | "fail";
  name: string;
  message: string;
  group: string;
  /** True if this result would be remediated by `brew bundle --file=Brewfile`. */
  brewfile?: boolean;
}

interface Check {
  name: string;
  group: string;
  run: () => CheckResult | Promise<CheckResult>;
}

function pass(group: string, name: string, message: string): CheckResult {
  return { status: "pass", group, name, message };
}

function warn(group: string, name: string, message: string): CheckResult {
  return { status: "warn", group, name, message };
}

function fail(group: string, name: string, message: string): CheckResult {
  return { status: "fail", group, name, message };
}

function brewfileFix(r: CheckResult): CheckResult {
  return { ...r, brewfile: true };
}

function whichCmd(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function cmdVersion(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: "pipe", encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function parseMajor(version: string): number | null {
  const match = version.replace(/^v/, "").match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/** Extract the first semver-shaped substring from version output. */
function parseVersion(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

/**
 * Ask Homebrew whether a managed package is behind. Returns latest version when
 * outdated, or null when fresh / not brew-managed / brew unavailable.
 */
function brewLatestIfOutdated(name: string, isCask: boolean): string | null {
  try {
    const flag = isCask ? "--cask" : "--formula";
    const out = execSync(`brew outdated ${flag} --json ${name}`, {
      stdio: "pipe",
      encoding: "utf-8",
    });
    const data = JSON.parse(out);
    const list = isCask ? data.casks : data.formulae;
    if (!Array.isArray(list) || list.length === 0) return null;
    return list[0]?.current_version ?? null;
  } catch {
    return null;
  }
}

/** Check a brew-managed external CLI: presence + version freshness. */
function checkBrewTool(opts: {
  bin: string;
  pkg: string;
  isCask: boolean;
  severity: "fail" | "warn";
}): CheckResult {
  const { bin, pkg, isCask, severity } = opts;
  const sev = severity === "fail" ? fail : warn;

  if (!whichCmd(bin)) {
    return brewfileFix(sev("Tools", bin, "not installed"));
  }

  const version = parseVersion(cmdVersion(`${bin} --version`));
  const latest = brewLatestIfOutdated(pkg, isCask);
  if (latest) {
    return brewfileFix(
      warn("Tools", bin, `${version ?? "?"} — outdated, latest ${latest}`),
    );
  }
  return pass("Tools", bin, version ?? "found on PATH");
}


const ICON = {
  pass: green("\u2713"),
  warn: yellow("\u26A0"),
  fail: red("\u2717"),
} as const;

// ── Checks ──────────────────────────────────────────────────────────────
const checks: Check[] = [
  // ── Configuration ─────────────────────────────
  {
    group: "Configuration",
    name: "Friday directory",
    run: () =>
      existsSync(FRIDAY_DIR)
        ? pass("Configuration", "Friday directory", FRIDAY_DIR)
        : fail("Configuration", "Friday directory", `${FRIDAY_DIR} not found — run ${dim("friday setup")}`),
  },
  {
    group: "Configuration",
    name: "Config file",
    run: () => {
      if (!existsSync(CONFIG_PATH)) {
        return fail("Configuration", "Config file", `${CONFIG_PATH} not found`);
      }
      try {
        const config = loadConfig();
        if (!config.slack.orchestratorChannelId) {
          return fail("Configuration", "Config file", "slack.orchestratorChannelId is empty");
        }
        return pass("Configuration", "Config file", CONFIG_PATH);
      } catch (err: any) {
        return fail("Configuration", "Config file", `invalid JSON: ${err.message}`);
      }
    },
  },
  {
    group: "Configuration",
    name: "Slack tokens",
    run: () => {
      if (!existsSync(ENV_PATH)) {
        return fail("Configuration", "Slack tokens", `${ENV_PATH} not found`);
      }
      const content = readFileSync(ENV_PATH, "utf-8");
      const hasBot = /^SLACK_BOT_TOKEN=.+/m.test(content);
      const hasApp = /^SLACK_APP_TOKEN=.+/m.test(content);
      if (hasBot && hasApp) return pass("Configuration", "Slack tokens", "both set");
      const missing = [!hasBot && "SLACK_BOT_TOKEN", !hasApp && "SLACK_APP_TOKEN"].filter(Boolean);
      return fail("Configuration", "Slack tokens", `missing ${missing.join(", ")}`);
    },
  },
  {
    group: "Configuration",
    name: "Working directory",
    run: () => {
      const config = loadConfig();
      const dir = config.agent.workingDirectory;
      if (!existsSync(dir)) {
        return fail("Configuration", "Working directory", `${dir} not found`);
      }
      try {
        accessSync(dir, constants.W_OK);
        return pass("Configuration", "Working directory", dir);
      } catch {
        return fail("Configuration", "Working directory", `${dir} not writable`);
      }
    },
  },
  {
    group: "Configuration",
    name: "Beads database",
    run: () => {
      if (!existsSync(join(BEADS_DIR, ".beads"))) {
        return warn("Configuration", "Beads database", `not initialized — run ${dim("friday setup")}`);
      }
      return pass("Configuration", "Beads database", BEADS_DIR);
    },
  },

  // ── Tools ─────────────────────────────────────
  {
    group: "Tools",
    name: "Node.js",
    run: () => {
      const version = cmdVersion("node --version");
      if (!version) return fail("Tools", "Node.js", "not found on PATH");
      const major = parseMajor(version);
      if (major === null) return fail("Tools", "Node.js", `could not parse version: ${version}`);
      if (major < 22) return fail("Tools", "Node.js", `${version} — requires >= 22`);
      return pass("Tools", "Node.js", version);
    },
  },
  {
    group: "Tools",
    name: "pnpm",
    run: () => {
      const version = cmdVersion("pnpm --version");
      if (!version) return warn("Tools", "pnpm", "not found on PATH");
      const major = parseMajor(version);
      if (major === null) return warn("Tools", "pnpm", `could not parse version: ${version}`);
      if (major < 10) return warn("Tools", "pnpm", `${version} — recommend >= 10`);
      return pass("Tools", "pnpm", version);
    },
  },
  {
    group: "Tools",
    name: "claude",
    run: () => checkBrewTool({ bin: "claude", pkg: "claude-code", isCask: true, severity: "fail" }),
  },
  {
    group: "Tools",
    name: "gh",
    run: () => checkBrewTool({ bin: "gh", pkg: "gh", isCask: false, severity: "warn" }),
  },
  {
    group: "Tools",
    name: "bd",
    run: () => checkBrewTool({ bin: "bd", pkg: "beads", isCask: false, severity: "warn" }),
  },
  {
    group: "Tools",
    name: "tmux",
    run: () => checkBrewTool({ bin: "tmux", pkg: "tmux", isCask: false, severity: "warn" }),
  },

  // ── Services ──────────────────────────────────
  {
    group: "Services",
    name: "Daemon",
    run: () => {
      const pid = readPid("daemon");
      if (pid && isRunning(pid)) {
        return pass("Services", "Daemon", `PID ${pid}`);
      }
      // Fall back to health.json heartbeat
      const healthPath = join(FRIDAY_DIR, "health.json");
      if (existsSync(healthPath)) {
        try {
          const health = JSON.parse(readFileSync(healthPath, "utf-8"));
          const age = Date.now() - new Date(health.lastHeartbeat).getTime();
          if (health.pid && isRunning(health.pid) && age < 120_000) {
            return pass("Services", "Daemon", `PID ${health.pid}`);
          }
        } catch { /* ignore */ }
      }
      return warn("Services", "Daemon", "stopped");
    },
  },
  {
    group: "Services",
    name: "Dashboard",
    run: () => {
      const pid = readPid("dashboard");
      if (pid && isRunning(pid)) {
        return pass("Services", "Dashboard", `PID ${pid}`);
      }
      // Probe known ports (dev 5173, preview 4173)
      for (const port of [5173, 4173]) {
        try {
          const code = execSync(
            `curl -s -o /dev/null -w "%{http_code}" --max-time 1 http://localhost:${port}/`,
            { stdio: "pipe", encoding: "utf-8" },
          ).trim();
          if (code === "200") {
            return pass("Services", "Dashboard", `port ${port}`);
          }
        } catch { /* connection refused or timeout */ }
      }
      return warn("Services", "Dashboard", "stopped");
    },
  },
];

// ── Runner & output ─────────────────────────────────────────────────────

export async function runChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await check.run());
  }
  return results;
}

export function printResults(results: CheckResult[], durationMs?: number): void {
  const passes = results.filter((r) => r.status === "pass").length;
  const warns = results.filter((r) => r.status === "warn").length;
  const fails = results.filter((r) => r.status === "fail").length;

  // Find the longest check name for alignment
  const maxName = Math.max(...results.map((r) => r.name.length));

  console.log();
  console.log(`  ${bold("Friday Doctor")}`);

  // Group and print
  let lastGroup = "";
  for (const r of results) {
    if (r.group !== lastGroup) {
      console.log();
      console.log(`  ${dim("\u2500\u2500")} ${dim(r.group)} ${dim("\u2500".repeat(Math.max(0, 44 - r.group.length)))}`);
      lastGroup = r.group;
    }
    const icon = ICON[r.status];
    const pad = " ".repeat(maxName - r.name.length);
    const msg = r.status === "pass" ? dim(r.message) : r.message;
    console.log(`     ${icon} ${r.name}${pad}  ${msg}`);
  }

  // Summary
  console.log();
  const parts: string[] = [];
  if (passes) parts.push(green(`${passes} passed`));
  if (warns) parts.push(yellow(`${warns} warning${warns > 1 ? "s" : ""}`));
  if (fails) parts.push(red(`${fails} failed`));
  const timing = durationMs !== undefined ? dim(`  ${durationMs}ms`) : "";
  const allGood = fails === 0 && warns === 0;
  const verdict = allGood ? `  ${green("\u2713")} ${bold("All good")}` : `  ${parts.join(dim(" \u00b7 "))}`;
  console.log(verdict + timing);

  // Consolidated remediation hint when any tool is missing or out of date.
  if (results.some((r) => r.brewfile)) {
    console.log(`  ${dim("\u2192")} Update brew tools: ${dim("brew bundle --file=Brewfile")}`);
  }
  console.log();
}

export const doctorCommandCitty = defineCommand({
  meta: {
    name: "doctor",
    description:
      "Validate your Friday installation. Checks ~/.friday/, config, .env tokens, working directory, beads database, CLI tools, Node, pnpm, and services. Exits 1 on any failure.",
  },
  async run() {
    await doctorCommand();
  },
});

export async function doctorCommand(): Promise<void> {
  console.log(BANNER);
  const t0 = Date.now();
  const results = await runChecks();
  const elapsed = Date.now() - t0;
  printResults(results, elapsed);
  const hasFail = results.some((r) => r.status === "fail");
  if (hasFail) process.exit(1);
}
