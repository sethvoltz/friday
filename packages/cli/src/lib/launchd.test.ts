/**
 * launchd plist + argv contract (FRI-146 / ADR-034, AC#13).
 *
 * `renderPlist()` and the `serviceTarget()`/`domainTarget()` argv builders are
 * the cross-boundary contract this codebase is most exposed to drift on: the
 * SAME plist contents are re-implemented byte-for-byte in `install.sh`'s
 * bash `write_plist` (and the dir layout in `install-paths.ts`). The file
 * headers of install.sh, launchd.ts, and update.ts all promise these stay in
 * sync. A bash-vs-TS divergence here is silent — the global testing rules
 * call cross-boundary contracts the nastiest place for drift — so this test
 * pins the exact shape the bash twin must match.
 *
 * `launchd.ts` imports `LOGS_DIR` from `@friday/shared`, which binds to the
 * data dir at import time, so FRIDAY_DATA_DIR is repointed to a scratch tmp
 * dir BEFORE the import (data-dir binding rule).
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "friday-launchd-data-"));
process.env.FRIDAY_DATA_DIR = DATA_DIR;
const LOGS_DIR = join(DATA_DIR, "logs");

const { renderPlist, FRIDAY_LAUNCHD_LABEL, serviceTarget, domainTarget, plistPath } =
  await import("./launchd.js");

/** Pull the ordered <string> values out of the ProgramArguments <array>. */
function programArguments(xml: string): string[] {
  const arrayBlock = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!arrayBlock) return [];
  return [...arrayBlock[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1]);
}

/** Pull the <string> value that immediately follows a given <key>. */
function valueForKey(xml: string, key: string): string | undefined {
  const m = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`));
  return m?.[1];
}

describe("renderPlist — bash-twin contract (AC#13)", () => {
  const installDir = "/Users/someone/.local/share/friday/current";
  const fnm = "/opt/homebrew/bin/fnm";
  const xml = renderPlist(installDir, fnm);

  it("ProgramArguments is exactly [fnm, exec, --, node, <installDir>/.../supervisor.js]", () => {
    const supervisorEntry = join(installDir, "packages", "cli", "dist", "bin", "supervisor.js");
    expect(programArguments(xml)).toEqual([fnm, "exec", "--", "node", supervisorEntry]);
  });

  it("Label is com.sethvoltz.friday", () => {
    expect(valueForKey(xml, "Label")).toBe("com.sethvoltz.friday");
    expect(FRIDAY_LAUNCHD_LABEL).toBe("com.sethvoltz.friday");
  });

  it("WorkingDirectory is the install dir (so fnm resolves .node-version there)", () => {
    expect(valueForKey(xml, "WorkingDirectory")).toBe(installDir);
  });

  it("StandardOut/ErrPath point under LOGS_DIR", () => {
    expect(valueForKey(xml, "StandardOutPath")).toBe(join(LOGS_DIR, "launchd.out.log"));
    expect(valueForKey(xml, "StandardErrorPath")).toBe(join(LOGS_DIR, "launchd.err.log"));
  });

  it("RunAtLoad + KeepAlive are set true", () => {
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("the only absolute Node-toolchain path is the fnm binary — no fnm-internal node path", () => {
    // The contract: fnm's internal per-version node location
    // (~/.local/share/fnm/node-versions/.../bin/node) is NEVER baked.
    expect(xml).not.toMatch(/node-versions/);
    // node is invoked by bare name under `fnm exec`, never by absolute path.
    expect(programArguments(xml)).toContain("node");
  });

  it("XML-escapes special characters in paths", () => {
    const tricky = renderPlist("/tmp/a&b<c>", "/opt/fnm");
    expect(tricky).toContain("/tmp/a&amp;b&lt;c&gt;");
    expect(tricky).not.toContain("/tmp/a&b<c>");
  });
});

describe("launchctl argv targets (AC#13)", () => {
  it("domainTarget is gui/<uid>", () => {
    const uid = process.getuid?.() ?? 0;
    expect(domainTarget()).toBe(`gui/${uid}`);
  });

  it("serviceTarget is gui/<uid>/com.sethvoltz.friday", () => {
    const uid = process.getuid?.() ?? 0;
    expect(serviceTarget()).toBe(`gui/${uid}/com.sethvoltz.friday`);
  });

  it("plistPath lands at ~/Library/LaunchAgents/<label>.plist", () => {
    expect(plistPath()).toMatch(/Library\/LaunchAgents\/com\.sethvoltz\.friday\.plist$/);
  });
});
