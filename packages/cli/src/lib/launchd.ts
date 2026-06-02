/**
 * Direct-launchd registration for Friday's supervisor (FRI-146 / ADR-033).
 *
 * Replaces the retired brew-services-based supervision. Generalizes the
 * cloudflared-plist-bypass pattern already shipped
 * (`installCloudflaredLaunchAgent` in setup.ts, ADR-028 §7): Friday writes +
 * bootstraps its OWN launchd plist rather than letting brew generate a job
 * for it.
 *
 * The plist launches the supervisor THROUGH fnm — `fnm exec -- node …` —
 * with `WorkingDirectory` set to the install dir so fnm's default
 * `.node-version` resolution finds the pinned version. Because the
 * supervisor is launched via `fnm exec`, `process.execPath` inside it IS
 * the fnm-resolved pinned node; the supervisor spawns its children via
 * `process.execPath` (see supervisor.ts buildSpecs), so no PATH prepend is
 * needed in the plist and no fnm-internal node path is ever baked.
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

/**
 * Render the plist XML for an install at `installDir`. The supervisor entry
 * is `<installDir>/packages/cli/dist/bin/supervisor.js`, launched through
 * `fnm exec -- node <entry>`. `WorkingDirectory` = `installDir` so fnm's
 * default `.node-version` resolution finds the pin.
 *
 * Exported so install.sh's bash re-implementation and tests can assert the
 * exact contract.
 */
export function renderPlist(installDir: string, fnm: string): string {
  const supervisorEntry = join(installDir, "packages", "cli", "dist", "bin", "supervisor.js");
  const stdoutPath = join(LOGS_DIR, "launchd.out.log");
  const stderrPath = join(LOGS_DIR, "launchd.err.log");
  const programArgs = [fnm, "exec", "--", "node", supervisorEntry];
  const argXml = programArgs.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(FRIDAY_LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
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

/** True if the job is currently bootstrapped (loaded) in the gui domain. */
export function isBootstrapped(): boolean {
  return launchctl(["print", serviceTarget()]).status === 0;
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
