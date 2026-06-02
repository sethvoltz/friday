/**
 * `friday uninstall` preserves user data by default (FRI-146 / ADR-033 §D,
 * AC#7). The teardown removes the plist + PATH shim + install tree, but
 * leaves `~/.friday/` (or `$FRIDAY_DATA_DIR`) and its contents intact unless
 * `--data=delete`.
 *
 * `launchctl bootout` is mocked so the real launchctl never runs; every
 * filesystem path resolves off HOME / FRIDAY_DATA_DIR, both repointed to a
 * scratch tmp dir BEFORE importing the module under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "friday-uninstall-home-"));
process.env.HOME = HOME;
process.env.FRIDAY_DATA_DIR = join(HOME, ".friday");

// Mock launchctl bootout so the real launchctl never runs. Everything else
// in launchd.ts (plistPath, etc.) resolves off HOME and is fine to keep.
const bootout = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
vi.mock("../lib/launchd.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/launchd.js")>();
  return { ...actual, bootout };
});

const { runUninstall } = await import("./uninstall.js");
const { plistPath } = await import("../lib/launchd.js");
const { installRoot, pathShim, versionDir } = await import("../lib/install-paths.js");
const { DATA_DIR } = await import("@friday/shared");

/** Lay down a full installed tree: plist, shim, a versions/<v>, current
 *  symlink, and a ~/.friday/config.json user-data file. */
function plantInstall(): { plist: string; shim: string; cfg: string } {
  // plist
  const plist = plistPath();
  mkdirSync(join(HOME, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plist, "<plist/>");
  // PATH shim
  const shim = pathShim();
  mkdirSync(join(HOME, ".local", "bin"), { recursive: true });
  writeFileSync(shim, "#!/usr/bin/env bash\n");
  // install tree
  const vdir = versionDir("1.0.0");
  mkdirSync(vdir, { recursive: true });
  writeFileSync(join(vdir, "package.json"), JSON.stringify({ version: "1.0.0" }));
  // user data
  const cfg = join(DATA_DIR, "config.json");
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(cfg, JSON.stringify({ some: "config" }));
  return { plist, shim, cfg };
}

describe("friday uninstall", () => {
  beforeEach(() => {
    bootout.mockClear();
    rmSync(installRoot(), { recursive: true, force: true });
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(plistPath(), { force: true });
    rmSync(pathShim(), { force: true });
  });

  afterEach(() => {
    rmSync(installRoot(), { recursive: true, force: true });
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(plistPath(), { force: true });
    rmSync(pathShim(), { force: true });
  });

  it("keep default: removes plist + shim + install tree, PRESERVES ~/.friday and config.json (AC#7)", () => {
    const { plist, shim, cfg } = plantInstall();

    // Pre-condition: everything exists.
    expect(existsSync(plist)).toBe(true);
    expect(existsSync(shim)).toBe(true);
    expect(existsSync(installRoot())).toBe(true);
    expect(existsSync(cfg)).toBe(true);

    const result = runUninstall("keep");

    // Distribution surface gone.
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(shim)).toBe(false);
    expect(existsSync(installRoot())).toBe(false);
    // launchctl bootout was attempted before plist removal.
    expect(bootout).toHaveBeenCalledTimes(1);

    // User data PRESERVED — both the dir and the known file under it.
    expect(existsSync(DATA_DIR)).toBe(true);
    expect(existsSync(cfg)).toBe(true);

    // Report reflects the keep.
    expect(result.removed).toContain(plist);
    expect(result.removed).toContain(shim);
    expect(result.removed).toContain(installRoot());
    expect(result.removed).not.toContain(DATA_DIR);
    expect(result.preserved).toContain(DATA_DIR);
  });

  it("--data=delete removes ~/.friday too", () => {
    const { cfg } = plantInstall();
    expect(existsSync(cfg)).toBe(true);

    const result = runUninstall("delete");

    expect(existsSync(DATA_DIR)).toBe(false);
    expect(existsSync(cfg)).toBe(false);
    expect(result.removed).toContain(DATA_DIR);
    expect(result.preserved).not.toContain(DATA_DIR);
  });

  it("is a no-op-safe teardown when nothing is installed", () => {
    // Nothing planted.
    const result = runUninstall("keep");
    expect(result.removed).toHaveLength(0);
    // Still attempts bootout (idempotent / best-effort).
    expect(bootout).toHaveBeenCalledTimes(1);
    // Preserve list still names the data dir.
    expect(result.preserved).toContain(DATA_DIR);
  });
});
