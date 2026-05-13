/**
 * Pure-function tests for the SBPL profile renderer. The kernel-side
 * behavior (does macOS actually deny these writes?) is tested in
 * `sandbox-profile-kernel.test.ts` — those tests shell out to
 * `/usr/bin/sandbox-exec` and only run on Darwin.
 */

import { describe, expect, it } from "vitest";
import { renderProfile } from "./sandbox-profile.js";

const PARAMS = {
  home: "/Users/test",
  dataDir: "/Users/test/.friday",
  worktree: "/Users/test/.friday/workspaces/alpha",
  logsDir: "/Users/test/.friday/logs",
};

describe("renderProfile", () => {
  it("emits (version 1) (allow default) preamble", () => {
    const out = renderProfile(PARAMS);
    expect(out).toMatch(/\(version 1\)/);
    expect(out).toMatch(/\(allow default\)/);
  });

  it("denies writes to ~/.ssh ~/.aws and friends", () => {
    const out = renderProfile(PARAMS);
    expect(out).toContain('(subpath "/Users/test/.ssh")');
    expect(out).toContain('(subpath "/Users/test/.aws")');
    expect(out).toContain('(subpath "/Users/test/.gcloud")');
    expect(out).toContain('(subpath "/Users/test/.kube")');
    expect(out).toContain('(subpath "/Users/test/.docker")');
    expect(out).toContain('(subpath "/Users/test/.gnupg")');
    expect(out).toContain('(subpath "/Users/test/.config/gh")');
    expect(out).toContain('(subpath "/Users/test/.netrc")');
  });

  it("denies writes to shell rc files by literal", () => {
    const out = renderProfile(PARAMS);
    expect(out).toContain('(literal "/Users/test/.zshrc")');
    expect(out).toContain('(literal "/Users/test/.bashrc")');
    expect(out).toContain('(literal "/Users/test/.bash_profile")');
    expect(out).toContain('(literal "/Users/test/.zprofile")');
    expect(out).toContain('(literal "/Users/test/.profile")');
    expect(out).toContain('(subpath "/Users/test/.config/fish")');
  });

  it("denies writes to LaunchAgents/LaunchDaemons and Keychains", () => {
    const out = renderProfile(PARAMS);
    expect(out).toContain('(subpath "/Users/test/Library/LaunchAgents")');
    expect(out).toContain('(subpath "/Users/test/Library/LaunchDaemons")');
    expect(out).toContain('(subpath "/Library/LaunchAgents")');
    expect(out).toContain('(subpath "/Library/LaunchDaemons")');
    expect(out).toContain('(subpath "/Users/test/Library/Keychains")');
    expect(out).toContain('(subpath "/Library/Keychains")');
  });

  it("denies writes to DATA_DIR but carves out logs + this-worktree", () => {
    const out = renderProfile(PARAMS);
    // The deny line comes before the allow carve-outs so last-match-wins
    // gives the worktree/logs allows.
    const denyIdx = out.indexOf(
      '(deny file-write* (subpath "/Users/test/.friday"))',
    );
    const allowLogsIdx = out.indexOf(
      '(allow file-write* (subpath "/Users/test/.friday/logs"))',
    );
    const allowWorktreeIdx = out.indexOf(
      '(allow file-write* (subpath "/Users/test/.friday/workspaces/alpha"))',
    );
    expect(denyIdx).toBeGreaterThanOrEqual(0);
    expect(allowLogsIdx).toBeGreaterThan(denyIdx);
    expect(allowWorktreeIdx).toBeGreaterThan(denyIdx);
  });

  it("denies process-exec of persistence and privilege footguns", () => {
    const out = renderProfile(PARAMS);
    expect(out).toContain('(literal "/usr/bin/launchctl")');
    expect(out).toContain('(literal "/usr/sbin/crontab")');
    expect(out).toContain('(literal "/usr/bin/at")');
    expect(out).toContain('(literal "/usr/bin/osascript")');
    expect(out).toContain('(literal "/usr/bin/sudo")');
    expect(out).toContain('(literal "/usr/bin/su")');
    expect(out).toContain('(literal "/usr/bin/defaults")');
    expect(out).toContain('(literal "/usr/bin/pmset")');
    expect(out).toContain('(literal "/usr/bin/tccutil")');
    expect(out).toContain('(literal "/usr/bin/sandbox-exec")');
  });
});
