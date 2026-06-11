/**
 * Direct-launchd registration for Friday's supervisor (FRI-146 / ADR-034).
 *
 * Replaces the retired brew-services-based supervision. Generalizes the
 * cloudflared-plist-bypass pattern already shipped
 * (`installCloudflaredLaunchAgent` in setup.ts, ADR-028 §7): Friday writes +
 * bootstraps its OWN launchd plist rather than letting brew generate a job
 * for it.
 *
 * The plist launches `bin/friday-supervisor` — a tiny bash shim that
 * resolves the pinned Node via fnm and execs node IN PLACE (with `exec -a
 * friday-supervisor`), so launchd's tracked process becomes node directly
 * and advertises itself as `friday-supervisor` in `ps` / Activity Monitor /
 * Login Items. fnm is the runtime resolver, not a long-lived wrapper (the
 * pre-fix plist was `fnm exec -- node …` which kept fnm alive as the
 * supervisor's parent — macOS surfaced that under Login Items & Extensions
 * every fresh boot as "fnm can run in the background").
 *
 * `EnvironmentVariables.FRIDAY_FNM_BIN` hands the shim the fnm absolute
 * path: launchd-spawned processes don't inherit user PATH, so we resolve
 * `$(brew --prefix)/bin/fnm` here (at plist-write time, in an interactive
 * context where brew is on PATH) and bake it into the plist. The shim
 * reads `$FRIDAY_FNM_BIN`. `friday doctor` verifies the baked binary is a
 * real exec.
 *
 * `WorkingDirectory` = install dir so fnm's default `.node-version`
 * resolution finds the pin. Because the supervisor runs under the
 * fnm-resolved node, `process.execPath` inside it IS that pinned node;
 * children are spawned via `process.execPath` (see supervisor.ts
 * buildSpecs), so no PATH prepend is needed and no fnm-internal node path
 * is ever baked.
 *
 * The ONLY absolute Node-toolchain path written anywhere is the fnm binary
 * at `$(brew --prefix)/bin/fnm`, a stable public locator resolved at write
 * time. fnm's own internal per-version node location is never written or
 * baked.
 *
 * Shared contract: `install.sh` re-implements the same plist contents and
 * the same dir layout in bash. Keep the two in sync.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LOGS_DIR } from "@friday/shared";

/** launchd job label. Vendor reverse-DNS convention (Seth is the vendor),
 *  following the same convention as cloudflared's `com.cloudflare.cloudflared`.
 *  Will not collide with that or with the retired brew-generated job label. */
export const FRIDAY_LAUNCHD_LABEL = "com.sethvoltz.friday";

/** `~/Library/LaunchAgents/com.sethvoltz.friday.plist`. */
export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${FRIDAY_LAUNCHD_LABEL}.plist`);
}

/** `gui/<uid>` domain for `launchctl bootstrap`. Mirrors status.ts's uid
 *  resolution. */
export function domainTarget(): string {
  const uid = process.getuid?.() ?? 0;
  return `gui/${uid}`;
}

/** `gui/<uid>/<label>` service target for `bootout` / `kickstart`. */
export function serviceTarget(): string {
  return `${domainTarget()}/${FRIDAY_LAUNCHD_LABEL}`;
}

/**
 * Resolve the fnm binary at the brew prefix (`$(brew --prefix)/bin/fnm`).
 * This is the single absolute Node-toolchain path the plist contains.
 * Returns `null` if brew can't be located (caller surfaces the error).
 */
export function fnmPath(): string | null {
  const r = spawnSync("brew", ["--prefix"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  const prefix = r.stdout.trim();
  if (!prefix) return null;
  return join(prefix, "bin", "fnm");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Env-var name through which the plist hands the shim the resolved fnm
 *  binary. Shared with `bin/friday-supervisor` and `friday doctor`. */
export const FRIDAY_FNM_BIN_ENV = "FRIDAY_FNM_BIN";

/**
 * Render the plist XML for an install at `installDir`. ProgramArguments is
 * the `bin/friday-supervisor` bash shim, which resolves fnm via
 * `$FRIDAY_FNM_BIN` (set in EnvironmentVariables) and execs node in place.
 * `WorkingDirectory` = `installDir` so fnm's `.node-version` lookup finds
 * the pin.
 *
 * Exported so install.sh's bash re-implementation and tests can assert the
 * exact contract.
 */
export function renderPlist(installDir: string, fnm: string): string {
  const supervisorShim = join(installDir, "bin", "friday-supervisor");
  const stdoutPath = join(LOGS_DIR, "launchd.out.log");
  const stderrPath = join(LOGS_DIR, "launchd.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(FRIDAY_LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(supervisorShim)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>${escapeXml(FRIDAY_FNM_BIN_ENV)}</key>
    <string>${escapeXml(fnm)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${escapeXml(installDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

/**
 * Write the plist to `~/Library/LaunchAgents/com.sethvoltz.friday.plist`.
 * Throws if brew can't be located (fnm is unresolvable).
 */
export function writePlist(installDir: string): void {
  const fnm = fnmPath();
  if (!fnm) {
    throw new Error(
      "cannot locate fnm: `brew --prefix` failed. Install fnm with `brew install fnm`.",
    );
  }
  const path = plistPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderPlist(installDir, fnm));
}

interface LaunchctlResult {
  status: number;
  stdout: string;
  stderr: string;
}

function launchctl(args: string[]): LaunchctlResult {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** True if the launchd job `label` is currently bootstrapped (loaded) in the
 *  gui domain. Label-agnostic `launchctl print gui/<uid>/<label>` probe, shared
 *  by the friday-supervisor check below and the cloudflared reconcile
 *  (`cloudflaredLoaded`, FRI-166) so there's one definition of "is this gui job
 *  loaded?" rather than separate hand-rolled copies. */
export function jobLoaded(label: string): boolean {
  const uid = process.getuid?.() ?? 0;
  return launchctl(["print", `gui/${uid}/${label}`]).status === 0;
}

/** True if the job is currently bootstrapped (loaded) in the gui domain. */
export function isBootstrapped(): boolean {
  return jobLoaded(FRIDAY_LAUNCHD_LABEL);
}

/**
 * Write the plist and bootstrap it into the gui domain. Idempotent: if the
 * job is already bootstrapped, re-writes the plist and kickstarts instead
 * of failing on a duplicate-bootstrap error.
 */
export function bootstrap(installDir: string): void {
  writePlist(installDir);
  if (isBootstrapped()) {
    // Already loaded — re-apply by kickstarting (picks up the freshly
    // written plist on next restart cycle via KeepAlive; -k forces it now).
    kickstart();
    return;
  }
  const r = launchctl(["bootstrap", domainTarget(), plistPath()]);
  if (r.status !== 0) {
    throw new Error(
      `launchctl bootstrap failed (${r.status}): ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
}

/** Bootout (unload) the job from the gui domain. Best-effort: a non-loaded
 *  job booting out is not an error worth surfacing. */
export function bootout(): LaunchctlResult {
  return launchctl(["bootout", serviceTarget()]);
}

/** `launchctl kickstart -k` — kill the running instance (if any) and
 *  restart it. */
export function kickstart(): LaunchctlResult {
  return launchctl(["kickstart", "-k", serviceTarget()]);
}
