import { defineCommand } from "citty";
import pc from "picocolors";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_PATH,
  DATA_DIR,
  AGE_KEY_PATH,
  ENV_LOCAL_PATH,
  ENV_PATH,
  FRIDAY_PG_CONSTANTS,
  unlockVault,
  validateBijection,
  LOGS_DIR,
  SOUL_PATH,
  closeDb,
  getDb,
  loadFridayConfig,
  probePostgresHealth,
  hasVectorExtension,
  schema,
  warmVaultCache,
} from "@friday/shared";
import { DaemonClient } from "../lib/api.js";
import { BANNER } from "../lib/branding.js";
import { launchdJobStatus } from "./status.js";
import { FRIDAY_FNM_BIN_ENV, FRIDAY_LAUNCHD_LABEL, plistPath } from "../lib/launchd.js";
import { currentLink } from "../lib/install-paths.js";
import { brewHas, resolveBrew } from "../lib/brew-deps.js";

type Section = "Dependencies" | "Configuration" | "Runtime" | "PostgreSQL";
type Status = "ok" | "warn" | "fail";
/** A row is `pending` while its check is still running, then resolves to a
 *  terminal `Status`. */
type RowStatus = Status | "pending";

interface DoctorCheck {
  section: Section;
  label: string;
  status: Status;
  value: string;
  hint?: string;
}

interface Row {
  label: string;
  status: RowStatus;
  value: string;
  hint?: string;
}

/**
 * Resolve the user's interactive shell the same way the daemon's shell-env
 * capture does (services/daemon/src/shell-env.ts): `$SHELL` unless it's unset
 * or the useless `/bin/sh`, then prefer zsh, then bash.
 */
function resolveInteractiveShell(exists: (p: string) => boolean = existsSync): string {
  const fromEnv = process.env.SHELL;
  if (fromEnv && fromEnv !== "/bin/sh" && exists(fromEnv)) return fromEnv;
  for (const c of ["/bin/zsh", "/bin/bash"]) if (exists(c)) return c;
  return fromEnv || "/bin/sh";
}

export interface ShellNodeProbe {
  ok: boolean;
  /** True when we couldn't run the probe faithfully (a shell whose `-ilc`
   *  invocation differs — fish/nu/csh/pwsh). Reported as `warn`, not `fail`,
   *  so we never false-alarm by running the wrong invocation. */
  unverified?: boolean;
  shell: string;
  /** Node version string on success, else a short reason. */
  detail: string;
}

/** Shells whose interactive-login env probe is `<shell> -ilc <cmd>`. The
 *  worker (shell-env.ts buildInvocation) uses different flags for fish/nu
 *  (`-i -l -c`), csh (`-ic`), pwsh (`-Login -Command`); rather than guess and
 *  false-fail, we mark those "unverified". */
const ILC_SHELLS = new Set(["zsh", "bash", "sh"]);

/** Unique marker so we can isolate node's version from any banner a login rc
 *  prints to stdout (fastfetch/motd/p10k). The worker does the same with
 *  START/END markers (shell-env.ts) — a bare `node -e` + `^v…` anchor would
 *  false-fail on every box whose rc echoes to stdout. */
const NODE_MARK = "__friday_node__";

/**
 * Probe whether `node` resolves and runs in the user's INTERACTIVE shell — the
 * exact context Friday's agent workers use. Each worker spawns `$SHELL -ilc`
 * and runs a `node -e` marker to capture the user's environment
 * (shell-env.ts:269). If node isn't on the interactive PATH (classically: fnm
 * installed but its `eval "$(fnm env)"` shell hook never added), that capture
 * fails, the worker falls back to the launchd minimal PATH, the Claude SDK
 * can't run, and EVERY agent turn silently completes with no reply — with no
 * error shown to the user. doctor's other dependency checks use `which` in
 * doctor's OWN process env, which has the install shim's PATH and so misses
 * this entirely. This check runs the real `$SHELL -ilc node -e …` instead.
 *
 * `spawnFn`/`shell` are injectable for tests (the real probe spawns a shell).
 */
export function probeInteractiveShellNode(
  spawnFn: typeof spawnSync = spawnSync,
  shell: string = resolveInteractiveShell(),
): ShellNodeProbe {
  const base = shell.split("/").pop() ?? shell;
  if (!ILC_SHELLS.has(base)) {
    return {
      ok: false,
      unverified: true,
      shell,
      detail: `unverified for ${base} (non -ilc shell) — ensure \`node\` runs in your interactive shell`,
    };
  }
  const r = spawnFn(
    shell,
    ["-ilc", `node -e 'process.stdout.write("${NODE_MARK}"+process.version)'`],
    { encoding: "utf8", timeout: 8000 },
  );
  // Extract the version that follows our marker — robust to a login rc that
  // prints a banner to stdout before the command runs.
  const m = (r.stdout ?? "").toString().match(new RegExp(`${NODE_MARK}(v\\d+\\.\\d+\\.\\d+)`));
  if (r.status === 0 && m) {
    return { ok: true, shell, detail: `node ${m[1]} resolvable in ${shell} -ilc` };
  }
  return { ok: false, shell, detail: `node not resolvable in ${shell} -ilc` };
}

/** Marker proving a `command -v` succeeded under the login shell — distinct
 *  from the resolved path itself, so a login rc banner echoing to stdout can't
 *  be mistaken for a hit (same rationale as NODE_MARK). */
const RESOLVE_MARK = "__friday_path__";

/**
 * Probe whether an arbitrary `cmd` resolves on the user's shell PATH. Two modes:
 *
 *  - interactive (default, `$SHELL -ilc`): the env the worker CAPTURES and — since
 *    FRI-150's env-injection (buildQueryOptions threads the captured env into the
 *    SDK `query()` options) — the env the agent's Claude Code process actually
 *    runs with. So this is the authoritative "can the agent find `cmd`" check.
 *    doctor's plain `which gh` runs in doctor's OWN process env (the terminal that
 *    launched it, with brew shellenv already sourced) and can pass on a box where
 *    the agent's captured env can't see `gh` at all.
 *
 *  - non-interactive (`$SHELL -c`): what a FRESHLY spawned, non-login shell sees —
 *    on zsh that sources ONLY `~/.zshenv` (not `.zshrc`/`.zprofile`). Used as a
 *    robustness signal: a tool present interactively but absent here lives in an
 *    interactive-only rc, so it survives our env-injection but would vanish in any
 *    nested shell the agent re-execs, and in the capture-failure fallback. The cure
 *    is to move the PATH line to `~/.zshenv` (sourced by every shell).
 *
 * `cmd` is a trusted literal at every call site (never user input); we only run
 * the probe for shells whose `-ilc`/`-c` invocation we know (bash/zsh/sh) —
 * fish/nu/csh/pwsh are reported unverified rather than probed with wrong flags.
 */
export function probeInteractiveShellCommand(
  cmd: string,
  opts: { interactive?: boolean } = {},
  spawnFn: typeof spawnSync = spawnSync,
  shell: string = resolveInteractiveShell(),
): ShellNodeProbe {
  const interactive = opts.interactive ?? true;
  const flags = interactive ? "-ilc" : "-c";
  const base = shell.split("/").pop() ?? shell;
  if (!ILC_SHELLS.has(base)) {
    return {
      ok: false,
      unverified: true,
      shell,
      detail: `unverified for ${base} (non ${flags} shell) — ensure \`${cmd}\` runs in your shell`,
    };
  }
  const r = spawnFn(
    shell,
    [flags, `command -v ${cmd} >/dev/null 2>&1 && printf '${RESOLVE_MARK}'`],
    { encoding: "utf8", timeout: 8000 },
  );
  if (r.status === 0 && (r.stdout ?? "").toString().includes(RESOLVE_MARK)) {
    return { ok: true, shell, detail: `${cmd} resolvable in ${shell} ${flags}` };
  }
  return { ok: false, shell, detail: `${cmd} not resolvable in ${shell} ${flags}` };
}

/**
 * The rc file sourced by EVERY invocation of a given shell — where a PATH line
 * belongs so both interactive AND the non-interactive shells agents spawn see
 * it. zsh has a clean answer (`~/.zshenv`); bash/sh do NOT (a non-interactive
 * `bash -c`/`sh -c` sources no startup file at all), so we fall back to the
 * conventional interactive rc and don't pretend a single file fixes the
 * non-interactive case. Keeps doctor's remediation accurate per the user's
 * actual `$SHELL` rather than hard-coding the zsh answer.
 */
function everyShellRc(shellBase: string): string {
  if (shellBase === "zsh") return "~/.zshenv";
  if (shellBase === "bash") return "~/.bashrc";
  return "your shell rc";
}

/**
 * Remediation hint for the `gh CLI` row. Pure (no spawns) so the 4-way decision
 * the dual-probe drives is unit-testable. Inputs:
 *  - agentOk/agentUnverified: the authoritative `$SHELL -ilc` probe (= the env
 *    the agent's Claude Code process runs with after FRI-150 env-injection).
 *  - nonInteractiveOk: the zsh-only `$SHELL -c` cross-check, or `undefined` when
 *    we didn't/ couldn't run it (non-zsh shell, or agent can't see gh anyway).
 *  - inProcessEnv: `which gh` in doctor's own env — disambiguates "not installed"
 *    from "installed but not on the agent PATH".
 *  - shellBase: basename of the resolved shell, drives the rc-file wording.
 */
export function ghCliHint(p: {
  agentOk: boolean;
  agentUnverified: boolean;
  nonInteractiveOk: boolean | undefined;
  inProcessEnv: boolean;
  shellBase: string;
}): string | undefined {
  if (p.agentUnverified) return undefined;
  const rc = everyShellRc(p.shellBase);
  if (!p.agentOk) {
    return p.inProcessEnv
      ? `installed but not on the agents' PATH — add gh's dir to ${rc} (e.g. \`eval "$(/opt/homebrew/bin/brew shellenv)"\`), open a new terminal. The agent runs with your captured shell env.`
      : `install with \`brew install gh\`, then ensure it's on ${rc}`;
  }
  // agentOk: only nudge when the non-interactive cross-check actually ran (zsh)
  // and failed — i.e. gh lives in an interactive-only rc. It works for the
  // agent's direct Bash today (injected env), but vanishes in nested shells.
  if (p.nonInteractiveOk === false) {
    return `resolves via your interactive rc only — move the PATH line to ${rc} (sourced by every shell) so nested agent shells and the capture-failure fallback find gh too`;
  }
  return undefined;
}

// Box dimensions. 68 columns matches the ASCII banner width (67) and the
// docs/architecture diagrams, fitting an 80-column terminal with margin.
// Adjust here only; the renderer derives everything else from these.
const WIDTH = 68;
const INNER = WIDTH - 2; // 66
const LABEL_COL = 23;
const VALUE_COL = INNER - 2 - 1 - 1 - LABEL_COL; // 39: 2 indent + 1 icon + 1 space + label + value = INNER

const ESC = "\x1b";

export const doctorCommand = defineCommand({
  meta: { name: "doctor", description: "Check system health" },
  async run() {
    console.log(BANNER);
    // Warm the vault BEFORE the first loadFridayConfig(). loadFridayConfig()
    // freezes a one-shot snapshot whose integration-secret overlay
    // (CLOUDFLARE_TUNNEL_TOKEN, etc.) is read from the vault cache at call
    // time. Without warming first, that snapshot memoizes an empty overlay and
    // vault-backed secrets — which now live in the age vault, not .env — read
    // as "absent" even when present.
    await warmVaultCache();
    if (existsSync(ENV_LOCAL_PATH) || existsSync(ENV_PATH)) loadFridayConfig();

    // Sections render one block at a time, live: each box paints its known
    // rows as pending, then flips each glyph (and the top-border count) in
    // place as results land, growing taller when a failing row needs a hint.
    // We move to the next block only once the current one is fully resolved.
    const checks: DoctorCheck[] = [];
    checks.push(...(await runDependencies()));
    checks.push(...(await runConfiguration()));
    checks.push(...(await runRuntime()));
    checks.push(...(await runPostgres()));

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
// LiveBox — a section box that paints once, then redraws in place as rows
// resolve. The top-border `( ok / total )` count and each row's glyph update
// in realtime; the box grows when a resolved row carries a hint.
// ============================================================================

class LiveBox {
  private readonly rows: Row[] = [];
  private prevLines = 0;
  private readonly tty = process.stdout.isTTY === true;
  private readonly out = process.stdout;

  constructor(private readonly section: Section) {}

  /** Pre-register a row in the `pending` state. Call before `draw()`. */
  declare(label: string): void {
    this.rows.push({ label, status: "pending", value: "" });
  }

  /** Paint the initial box (all rows pending). */
  draw(): void {
    this.paint();
  }

  /** Flip a previously-declared row to a terminal status and repaint. */
  resolve(label: string, status: Status, value: string, hint?: string): void {
    const row = this.rows.find((r) => r.label === label);
    if (!row) throw new Error(`LiveBox(${this.section}): no declared row "${label}"`);
    row.status = status;
    row.value = value;
    row.hint = hint;
    this.paint();
  }

  /** Insert an already-resolved row that wasn't known up front (a conditional
   *  warning). `opts.after` positions it just below an existing row. */
  add(
    status: Status,
    label: string,
    value: string,
    hint: string | undefined,
    opts?: { after?: string },
  ): void {
    const row: Row = { label, status, value, hint };
    const at = opts?.after ? this.rows.findIndex((r) => r.label === opts.after) : -1;
    if (at >= 0) this.rows.splice(at + 1, 0, row);
    else this.rows.push(row);
    this.paint();
  }

  /** Remove a declared row that turned out not to apply (box shrinks). */
  drop(label: string): void {
    const at = this.rows.findIndex((r) => r.label === label);
    if (at >= 0) this.rows.splice(at, 1);
    this.paint();
  }

  /** Finalize the block: emit the trailing blank line that separates sections.
   *  On a non-TTY we never animated, so render the final box once here. */
  done(): void {
    if (this.tty) {
      this.out.write("\n");
    } else {
      this.out.write(this.render().join("\n") + "\n\n");
    }
  }

  /** The resolved rows, as `DoctorCheck`s for the final summary. */
  toChecks(): DoctorCheck[] {
    return this.rows
      .filter((r) => r.status !== "pending")
      .map((r) => ({
        section: this.section,
        label: r.label,
        status: r.status as Status,
        value: r.value,
        hint: r.hint,
      }));
  }

  // -- internals -------------------------------------------------------------

  /** Redraw in place: move the cursor up over the previous frame, clear to the
   *  end of the screen, then write the new (possibly taller) frame. On a
   *  non-TTY we defer all output to `done()` so piped logs stay clean. */
  private paint(): void {
    if (!this.tty) return;
    const lines = this.render();
    let frame = "";
    if (this.prevLines > 0) frame += `${ESC}[${this.prevLines}A\r${ESC}[0J`;
    frame += lines.join("\n") + "\n";
    this.out.write(frame);
    this.prevLines = lines.length;
  }

  private render(): string[] {
    const ok = this.rows.filter((r) => r.status === "ok").length;
    const total = this.rows.length;
    const lines: string[] = [renderTopBorder(this.section, ok, total), renderBlankLine()];
    for (const row of this.rows) {
      lines.push(renderRow(row));
      if (row.status !== "pending" && row.hint) {
        for (const wrapped of wrapText(row.hint, INNER - 6)) lines.push(renderHintLine(wrapped));
      }
    }
    lines.push(renderBlankLine(), renderBottomBorder());
    return lines;
  }
}

// ============================================================================
// Section runners — each declares its known rows, paints, then resolves them
// one by one as the (sometimes slow) probes complete.
// ============================================================================

export async function runDependencies(): Promise<DoctorCheck[]> {
  const box = new LiveBox("Dependencies");
  for (const label of [
    "fnm",
    "node version",
    "claude CLI",
    "node in shell",
    "gh CLI",
    "postgres",
    "pgvector",
    "cloudflared",
    "install tree",
  ]) {
    box.declare(label);
  }
  box.draw();

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
  box.resolve(
    "fnm",
    fnmOk ? "ok" : "fail",
    fnmOk ? displayPath(fnmAbs) : "missing",
    fnmOk ? undefined : "install with `brew install fnm`",
  );

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
  box.resolve(
    "node version",
    pinOk ? "ok" : "fail",
    pinOk ? `pinned (${pinValue})` : "missing",
    pinOk ? undefined : "re-run `friday update` to repopulate the install tree",
  );

  // claude CLI
  const claudeOk = spawnSync("which", ["claude"], { encoding: "utf8" }).status === 0;
  box.resolve(
    "claude CLI",
    claudeOk ? "ok" : "fail",
    claudeOk ? "installed" : "missing",
    claudeOk
      ? undefined
      : "install via `curl -fsSL https://claude.ai/install.sh | bash` or `brew install --cask claude-code`",
  );

  // node in the INTERACTIVE shell — the context agent workers actually run in
  // (`$SHELL -ilc`, shell-env.ts). The `node version` row above only checks the
  // .node-version pin in the install tree; THIS catches "fnm installed but its
  // shell hook never added", which silently kills every agent turn (no reply,
  // no error) — exactly the prod→Intel migration failure.
  const shellNode = probeInteractiveShellNode();
  box.resolve(
    "node in shell",
    shellNode.unverified ? "warn" : shellNode.ok ? "ok" : "fail",
    shellNode.ok || shellNode.unverified ? shellNode.detail : "not resolvable",
    shellNode.ok || shellNode.unverified
      ? undefined
      : `agents can't run — add  eval "$(fnm env)"  to ${everyShellRc(shellNode.shell.split("/").pop() ?? "")} (sourced by every shell, so non-interactive ones get it too), open a new terminal. The agent runs with your captured \`${shellNode.shell} -ilc\` env and needs node there.`,
  );

  // gh CLI — the one external CLI the AGENT itself shells out to (orchestrator
  // and builders open PRs / read issues). The agent's Claude Code process runs
  // with the worker's captured `$SHELL -ilc` env (FRI-150 env-injection), so the
  // interactive probe is the authoritative "can the agent find gh" check — NOT
  // doctor's own `which gh`, which passes from a terminal that already sourced
  // brew shellenv even when the captured env can't see it. For zsh users we also
  // cross-check the non-interactive shell (`$SHELL -c`, which sources only
  // ~/.zshenv): gh present interactively but not there lives in an
  // interactive-only rc — fine for the agent's direct Bash today, but it'd vanish
  // in any nested shell the agent re-execs and in the capture-failure fallback,
  // so we nudge toward ~/.zshenv. The cross-check is skipped for bash/sh (their
  // `-c` sources nothing, so it can't point at a single fix). `which gh` in
  // process env disambiguates "not installed" from "installed but off the PATH".
  const ghAgent = probeInteractiveShellCommand("gh", { interactive: true });
  const ghShellBase = ghAgent.shell.split("/").pop() ?? ghAgent.shell;
  const ghNonInteractive =
    ghShellBase === "zsh" && ghAgent.ok
      ? probeInteractiveShellCommand("gh", { interactive: false })
      : undefined;
  const ghInProcessEnv = spawnSync("which", ["gh"], { encoding: "utf8" }).status === 0;
  const ghHint = ghCliHint({
    agentOk: ghAgent.ok,
    agentUnverified: ghAgent.unverified ?? false,
    nonInteractiveOk: ghNonInteractive ? ghNonInteractive.ok : undefined,
    inProcessEnv: ghInProcessEnv,
    shellBase: ghShellBase,
  });
  box.resolve(
    "gh CLI",
    ghAgent.unverified ? "warn" : ghAgent.ok ? "ok" : "fail",
    ghAgent.ok || ghAgent.unverified ? ghAgent.detail : "not on agent PATH",
    ghHint,
  );

  // postgres: postgresql@18 is keg-only, so psql often isn't on PATH even
  // though the formula is installed. Prefer `brew list postgresql@18` (which
  // reports whether the keg is installed regardless of linking) and fall back
  // to `which psql` for non-brew installs. `resolveBrew()` finds brew by
  // absolute path so this is correct even off an interactive PATH.
  const psqlOk =
    spawnSync(resolveBrew(), ["list", "postgresql@18"], { encoding: "utf8" }).status === 0 ||
    spawnSync("which", ["psql"], { encoding: "utf8" }).status === 0;
  box.resolve(
    "postgres",
    psqlOk ? "ok" : "fail",
    psqlOk ? "installed" : "missing",
    psqlOk ? undefined : "install with `brew install postgresql@18`",
  );

  // pgvector binary (FRI-24): supplies the `vector` type/extension migration
  // 0036 needs. Without it the daemon crash-loops at boot, so this is a HARD
  // dep — the remedy is the one-shot `friday provision`. (The extension itself
  // is checked in the PostgreSQL section once a DB connection is available.)
  const pgvectorOk = brewHas("pgvector");
  box.resolve(
    "pgvector",
    pgvectorOk ? "ok" : "fail",
    pgvectorOk ? "installed" : "missing",
    pgvectorOk ? undefined : "run `friday provision` (installs pgvector + enables the extension)",
  );

  // cloudflared (warn if missing — only required for the public tunnel)
  const cflOk = spawnSync("which", ["cloudflared"], { encoding: "utf8" }).status === 0;
  box.resolve(
    "cloudflared",
    cflOk ? "ok" : "warn",
    cflOk ? "installed" : "missing",
    cflOk ? undefined : "only required for the public tunnel — `brew install cloudflared`",
  );

  // install tree
  box.resolve(
    "install tree",
    installOk ? "ok" : "fail",
    installOk ? displayPath(link) : "missing",
    installOk
      ? undefined
      : "install via `curl -fsSL https://raw.githubusercontent.com/sethvoltz/friday/main/install.sh | bash`",
  );

  box.done();
  return box.toChecks();
}

async function runConfiguration(): Promise<DoctorCheck[]> {
  const box = new LiveBox("Configuration");
  for (const label of [
    "data dir",
    "config",
    ".env.local",
    "secrets vault",
    ".age-key",
    "SOUL.md",
    "primary account",
    "cloudflare token",
    "ZERO_AUTH_SECRET",
  ]) {
    box.declare(label);
  }
  box.draw();

  const dataDirOk = existsSync(DATA_DIR);
  box.resolve(
    "data dir",
    dataDirOk ? "ok" : "fail",
    displayPath(DATA_DIR),
    dataDirOk ? undefined : "run `friday setup` to create",
  );
  box.resolve("config", existsSync(CONFIG_PATH) ? "ok" : "fail", displayPath(CONFIG_PATH));
  const envLocalOk = existsSync(ENV_LOCAL_PATH) || existsSync(ENV_PATH);
  box.resolve(
    ".env.local",
    envLocalOk ? "ok" : "fail",
    existsSync(ENV_LOCAL_PATH) ? displayPath(ENV_LOCAL_PATH) : displayPath(ENV_PATH),
    envLocalOk ? undefined : "run `friday setup`",
  );

  const vaultUnlock = await unlockVault(true);
  box.resolve(
    "secrets vault",
    vaultUnlock.ok ? "ok" : existsSync(ENV_PATH) ? "warn" : "fail",
    vaultUnlock.ok ? "unlocked" : (vaultUnlock.reason ?? "missing"),
    vaultUnlock.ok ? undefined : "run `friday secrets init` + `friday secrets migrate-from-env`",
  );
  if (vaultUnlock.ok) {
    const bio = validateBijection(
      vaultUnlock.cache.meta,
      new Set(Object.keys(vaultUnlock.cache.payload.secrets)),
    );
    if (!bio.ok) {
      box.add("fail", "secrets bijection", "meta/vault mismatch", "run `friday secrets list`");
    }
  }

  if (existsSync(AGE_KEY_PATH)) {
    const mode = statSync(AGE_KEY_PATH).mode & 0o777;
    box.resolve(
      ".age-key",
      mode === 0o600 ? "ok" : "warn",
      mode === 0o600 ? "0600" : `mode ${mode.toString(8)}`,
      mode === 0o600 ? undefined : "chmod 600 ~/.friday/.age-key",
    );
  } else {
    box.resolve(".age-key", "warn", "missing", "run `friday secrets init`");
  }

  if (existsSync(ENV_PATH)) {
    box.add(
      "warn",
      "legacy .env",
      "plaintext present",
      "migrate with `friday secrets migrate-from-env`",
    );
  }

  box.resolve("SOUL.md", existsSync(SOUL_PATH) ? "ok" : "fail", displayPath(SOUL_PATH));

  // primary account
  let accountOk = false;
  try {
    const db = getDb();
    const users = await db.select().from(schema.users).limit(1);
    accountOk = users.length > 0;
  } catch {
    // db not migrated yet — handled by the PostgreSQL section
  }
  box.resolve(
    "primary account",
    accountOk ? "ok" : "fail",
    accountOk ? "present" : "missing",
    accountOk ? undefined : "run `friday setup`",
  );

  // Cloudflare Tunnel token — informational; tunnel is opt-in.
  // FRI-150 (ADR-037): read via loadFridayConfig() instead of process.env so
  // a clean daemon process tree doesn't leak the token into MCP children.
  const tunnelTokenSet = !!loadFridayConfig().cloudflareTunnelToken;
  box.resolve(
    "cloudflare token",
    tunnelTokenSet ? "ok" : "warn",
    tunnelTokenSet ? "present" : "absent",
    tunnelTokenSet ? undefined : "public tunnel disabled — `friday setup --cloudflare` to enable",
  );

  // ZERO_AUTH_SECRET is a config/env secret. FRI-150 (ADR-037) — read via
  // loadFridayConfig() instead of process.env so the daemon process tree
  // stays clean of secrets. Decoupled from the slow pg probe so the row
  // renders even when Postgres is down.
  const zeroAuthSecretPresent = !!loadFridayConfig().zeroAuthSecret;
  box.resolve(
    "ZERO_AUTH_SECRET",
    zeroAuthSecretPresent ? "ok" : "fail",
    zeroAuthSecretPresent ? "present" : "missing",
    zeroAuthSecretPresent ? undefined : "run `friday setup` to generate the secret",
  );

  // ---- Stale-state warnings (conditional rows; box grows if present) -------

  if (existsSync(ENV_PATH)) {
    try {
      const envText = readFileSync(ENV_PATH, "utf8");
      if (/^ZERO_MUTATE_URL=/m.test(envText)) {
        box.add(
          "warn",
          "ZERO_MUTATE_URL",
          "stale in .env",
          "remove this line — the supervisor exports it dynamically at spawn time",
        );
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
      box.add(
        "warn",
        "config.json fields",
        `stale: ${stale.join(", ")}`,
        "remove from config.json — defaults resolve via PROD_*_PORT constants",
      );
    }
  } catch {
    // ignore missing/malformed config — covered by the "config" check above
  }

  box.done();
  return box.toChecks();
}

async function runRuntime(): Promise<DoctorCheck[]> {
  const box = new LiveBox("Runtime");
  for (const label of ["logs dir", "friday-supervisor", "daemon", "zero-cache"]) {
    box.declare(label);
  }
  box.draw();

  box.resolve("logs dir", existsSync(LOGS_DIR) ? "ok" : "fail", displayPath(LOGS_DIR));

  const fridayJob = launchdJobStatus(FRIDAY_LAUNCHD_LABEL);
  box.resolve(
    "friday-supervisor",
    fridayJob.loaded ? "ok" : "fail",
    `(launchd: ${FRIDAY_LAUNCHD_LABEL})`,
    fridayJob.loaded ? undefined : "run `friday start`",
  );

  // Plist exec target audit — show only when broken, so the steady-state
  // doctor stays tight. A broken target crash-loops the supervisor without a
  // clear cause; surfacing it here points the operator at the right fix.
  const pp = plistPath();
  if (existsSync(pp)) {
    const parsed = readPlistJson(pp);
    const programArg0 = parsed?.ProgramArguments?.[0];
    if (!isExecutable(programArg0)) {
      box.add(
        "fail",
        "plist exec",
        programArg0 ?? "<unset>",
        "re-run `friday start` to rewrite the plist",
        {
          after: "friday-supervisor",
        },
      );
    }
  }

  // daemon reachable (localhost)
  const client = new DaemonClient();
  const daemonReachable = await client.ping();
  box.resolve(
    "daemon",
    daemonReachable ? "ok" : "fail",
    daemonReachable ? "reachable (localhost)" : "unreachable",
    daemonReachable ? undefined : "run `friday start`",
  );

  // zero-cache reachable
  const zeroReachable = await tcpReachable("127.0.0.1", 4848, 500);
  box.resolve(
    "zero-cache",
    zeroReachable ? "ok" : "fail",
    zeroReachable ? "reachable (localhost:4848)" : "unreachable",
    zeroReachable ? undefined : "run `friday start`",
  );

  // Orphaned zero-cache replica WAL — large WAL with no live zero-cache
  // suggests an unclean previous shutdown that the auto-reset loop hasn't
  // re-checkpointed.
  const walPath = join(DATA_DIR, "zero", "replica.db-wal");
  if (existsSync(walPath)) {
    try {
      const walSize = statSync(walPath).size;
      if (walSize > 0 && !zeroReachable) {
        box.add(
          "warn",
          "zero-cache WAL",
          `orphaned (${walSize} bytes)`,
          "unclean previous shutdown — `rm -rf ~/.friday/zero/` to force a fresh sync",
        );
      }
    } catch {
      // ignore
    }
  }

  box.done();
  return box.toChecks();
}

async function runPostgres(): Promise<DoctorCheck[]> {
  const box = new LiveBox("PostgreSQL");
  // Declare the happy-path rows; if Postgres is unreachable (or the probe
  // throws) we drop the detail rows the probe can't answer.
  const detailRows = ["role", "database", "migrations", "publication", "wal_level", "vector ext"];
  box.declare("daemon");
  for (const label of detailRows) box.declare(label);
  box.draw();

  try {
    const pg = await probePostgresHealth();
    const { FRIDAY_DB, FRIDAY_ROLE, FRIDAY_PUBLICATION } = FRIDAY_PG_CONSTANTS;
    if (!pg.reachable) {
      for (const label of detailRows) box.drop(label);
      box.resolve(
        "daemon",
        "fail",
        "unreachable",
        pg.reachableReason ?? "`brew services start postgresql@18`",
      );
    } else {
      box.resolve("daemon", "ok", "reachable (localhost)");
      box.resolve(
        "role",
        pg.roleExists ? "ok" : "fail",
        pg.roleExists ? FRIDAY_ROLE : "missing",
        pg.roleExists ? undefined : "run `friday setup`",
      );
      box.resolve(
        "database",
        pg.databaseExists ? "ok" : "fail",
        pg.databaseExists ? FRIDAY_DB : "missing",
        pg.databaseExists ? undefined : "run `friday setup`",
      );
      box.resolve(
        "migrations",
        pg.migrationsAtHead ? "ok" : "fail",
        pg.migrationsAtHead
          ? `at head (${pg.migrationsApplied}/${pg.migrationsExpected})`
          : `${pg.migrationsApplied}/${pg.migrationsExpected} applied`,
        pg.migrationsAtHead ? undefined : "run `friday setup` to apply pending migrations",
      );
      box.resolve(
        "publication",
        pg.publicationExists ? "ok" : "fail",
        pg.publicationExists ? FRIDAY_PUBLICATION : "missing",
        pg.publicationExists ? undefined : "run `friday setup`",
      );
      box.resolve(
        "wal_level",
        pg.walLevelLogical ? "ok" : "fail",
        pg.walLevelLogical ? "logical" : (pg.walLevelActual ?? "unknown"),
        pg.walLevelLogical
          ? undefined
          : "run `friday setup`, then `brew services restart postgresql@18`",
      );
      // pgvector `vector` extension (FRI-24) — the HARD dep migration 0036
      // needs. Only meaningful once the database exists.
      if (pg.databaseExists) {
        const vectorExt = await hasVectorExtension();
        box.resolve(
          "vector ext",
          vectorExt ? "ok" : "fail",
          vectorExt ? "enabled" : "missing",
          vectorExt ? undefined : "run `friday provision` (enables the pgvector extension)",
        );
      } else {
        box.drop("vector ext");
      }
    }
  } catch (err) {
    // Probe blew up entirely — collapse to a single health-probe failure row.
    box.drop("daemon");
    for (const label of detailRows) box.drop(label);
    box.add("fail", "health probe", "failed", err instanceof Error ? err.message : String(err));
  }

  box.done();
  return box.toChecks();
}

// ============================================================================
// Row + border rendering
// ============================================================================

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

function renderRow(row: Row): string {
  const icon = statusIcon(row.status);
  const labelArea = padTo(row.label, LABEL_COL);
  // Pending rows show no value yet — the glyph carries the "checking" signal.
  const valueArea = padTo(row.status === "pending" ? "" : row.value, VALUE_COL);
  return `│  ${icon} ${labelArea}${valueArea}│`;
}

function renderHintLine(hint: string): string {
  // │      - <hint padded to (INNER - 6)>│
  const prefix = "    - ";
  const body = padTo(hint, INNER - prefix.length);
  return `│${prefix}${pc.dim(body)}│`;
}

function statusIcon(status: RowStatus): string {
  switch (status) {
    case "ok":
      return pc.green("✔");
    case "warn":
      return pc.yellow("⚠");
    case "fail":
      return pc.red("✘");
    case "pending":
      // No true orange in the 16-color palette; yellow is the conventional
      // in-progress hue. `◌` reads as "not yet filled in".
      return pc.yellow("◌");
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
