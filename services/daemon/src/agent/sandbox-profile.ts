/**
 * macOS `sandbox-exec` profile generation for Builder workers (M2 in the
 * Builder-sandboxing plan). Each Builder is forked under a per-worker SBPL
 * profile so the kernel denies writes to credentials, dotfiles, LaunchAgents,
 * Keychains, and the daemon's own state — defense-in-depth behind the M1
 * PreToolUse rules.
 *
 * Profile shape is `(allow default)` with explicit denies. We are not
 * building a jail; we are stopping catastrophes. Narrow allowlists tried in
 * earlier iterations broke too many legitimate dev tools (Volta/mise/asdf
 * paths, brew, xcrun, etc.) to be honest. The kernel rules below are the
 * floor; M1 is the soft layer.
 *
 * Profile language reference: SBPL (TinyScheme-derived). Last matching rule
 * wins for a given operation. Allow carve-outs (e.g. the Builder's own
 * worktree) appear AFTER the broader deny they're punching through.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, LOGS_DIR } from "@friday/shared";

const PROFILES_DIR = join(DATA_DIR, "profiles");

export interface RenderInput {
  /** User's HOME — realpath'd by the caller. */
  home: string;
  /** Friday's data dir — realpath'd. */
  dataDir: string;
  /** Builder's working directory (its git worktree) — realpath'd. */
  worktree: string;
  /** Logs dir; carved out of the DATA_DIR deny. */
  logsDir: string;
}

/**
 * Render the SBPL profile text for a Builder. Pure function; takes already-
 * resolved paths so the caller controls realpath canonicalization.
 *
 * IMPORTANT: do not interpolate untrusted strings here. The paths come from
 * Friday's own config + the worktree (Friday-created); they pass through
 * SBPL as string literals. We don't quote-escape — if a path contained a
 * literal `"`, the profile would fail to parse, the integration tests would
 * catch it, and we'd reject the workspace name before reaching this point.
 */
export function renderProfile(input: RenderInput): string {
  const { home, dataDir, worktree, logsDir } = input;
  return `; Friday Builder sandbox profile — generated, do not edit
(version 1)
(allow default)

; ─── Credentials ───────────────────────────────────────────────────────
(deny file-write*
  (subpath "${home}/.ssh")
  (subpath "${home}/.aws")
  (subpath "${home}/.gcloud")
  (subpath "${home}/.kube")
  (subpath "${home}/.docker")
  (subpath "${home}/.gnupg")
  (subpath "${home}/.config/gh")
  (subpath "${home}/.config/git")
  (subpath "${home}/.netrc"))

; ─── Shell rc files ───────────────────────────────────────────────────
(deny file-write*
  (literal "${home}/.zshrc")
  (literal "${home}/.zprofile")
  (literal "${home}/.bashrc")
  (literal "${home}/.bash_profile")
  (literal "${home}/.profile")
  (subpath "${home}/.config/fish"))

; ─── Persistence + keychains ──────────────────────────────────────────
(deny file-write*
  (subpath "${home}/Library/LaunchAgents")
  (subpath "${home}/Library/LaunchDaemons")
  (subpath "/Library/LaunchAgents")
  (subpath "/Library/LaunchDaemons")
  (subpath "${home}/Library/Keychains")
  (subpath "/Library/Keychains"))

; ─── Friday's own state ───────────────────────────────────────────────
; The daemon owns DATA_DIR (SQLite, memory store, sibling worktrees).
; Builders write only to their own worktree and to the shared logs dir.
; The two allow rules come AFTER the broad deny so last-match-wins gives
; the carve-out (verified by sandbox-profile-kernel.test.ts).
(deny file-write* (subpath "${dataDir}"))
(allow file-write* (subpath "${logsDir}"))
(allow file-write* (subpath "${worktree}"))

; ─── Process exec — block persistence + privilege footguns ────────────
; M1 already denies these at the PreToolUse layer; this is the kernel
; backstop for the soft-layer's regex evasion (e.g. resolving paths via
; PATH-wrapped shims). Also blocks re-invoking sandbox-exec with a
; looser profile from inside the box.
(deny process-exec
  (literal "/usr/bin/launchctl")
  (literal "/usr/sbin/crontab")
  (literal "/usr/bin/at")
  (literal "/usr/bin/osascript")
  (literal "/usr/bin/sudo")
  (literal "/usr/bin/su")
  (literal "/usr/bin/defaults")
  (literal "/usr/bin/pmset")
  (literal "/usr/bin/tccutil")
  (literal "/usr/bin/sandbox-exec"))
`;
}

/**
 * Write a profile to disk for the given agent. Returns the path. Caller
 * is responsible for `removeProfile` on worker exit.
 */
export function writeProfile(agentName: string, input: RenderInput): string {
  if (!existsSync(PROFILES_DIR)) {
    mkdirSync(PROFILES_DIR, { recursive: true });
  }
  // Allow the profile name to embed the pid only via the caller — the agent
  // name is enough for ownership and overwriting prior runs is safe (we
  // re-render every fork).
  const path = join(PROFILES_DIR, `${sanitize(agentName)}.sb`);
  const text = renderProfile(input);
  writeFileSync(path, text);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort; not load-bearing.
  }
  return path;
}

export function removeProfile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Already gone.
  }
}

/**
 * Cached check: is the `sandbox-exec` wrap available *and* enabled? Reads
 * `FRIDAY_SANDBOX_EXEC` at first call. Override to `0` / `false` disables;
 * any other value (or unset) enables, contingent on the binary existing.
 */
let availabilityCache: { available: boolean; reason: string } | undefined;

export function sandboxExecAvailable(): { available: boolean; reason: string } {
  if (availabilityCache) return availabilityCache;
  const flag = process.env.FRIDAY_SANDBOX_EXEC;
  if (flag === "0" || flag === "false" || flag === "no") {
    availabilityCache = { available: false, reason: "disabled-by-env" };
    return availabilityCache;
  }
  try {
    // Probe by running `sandbox-exec` with no args. Exits non-zero with a
    // usage message, but the binary existing + executing is all we need.
    execFileSync("/usr/bin/sandbox-exec", [], { stdio: "ignore" });
    availabilityCache = { available: true, reason: "ok" };
  } catch (err) {
    const code = (err as { code?: string; status?: number }).code;
    const status = (err as { status?: number }).status;
    // ENOENT = binary missing (non-macOS, or removed); any other failure
    // with a status code means the binary ran (and exited non-zero on the
    // missing args), which counts as "available."
    if (code === "ENOENT") {
      availabilityCache = { available: false, reason: "binary-not-found" };
    } else if (typeof status === "number") {
      availabilityCache = { available: true, reason: "ok" };
    } else {
      availabilityCache = { available: false, reason: "probe-failed" };
    }
  }
  return availabilityCache;
}

/** Test-only: clear the cached availability so a re-probe runs. */
export function __resetSandboxExecAvailabilityCache(): void {
  availabilityCache = undefined;
}

/**
 * Resolve template inputs for a worker. Uses realpath so a symlink in any
 * path component can't trick the SBPL into allowing writes to an alternate
 * resolution target.
 */
export function profileInputsFor(worktreePath: string): RenderInput {
  return {
    home: safeReal(homedir()),
    dataDir: safeReal(DATA_DIR),
    worktree: safeReal(worktreePath),
    logsDir: safeReal(LOGS_DIR),
  };
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Strip path separators / unusual chars from the agent name. */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
