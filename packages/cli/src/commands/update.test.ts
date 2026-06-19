/**
 * `friday update` flip/rollback/check + sha256-verify logic (FRI-146 /
 * ADR-034). The network, tar-extract, fnm-install, and launchctl side
 * effects are injected via the `UpdateDeps` seam so these tests exercise the
 * symlink-flip, version-resolution, and verify logic against scratch tmp
 * dirs — no network, no real launchctl, no fnm.
 *
 * `installRoot()` resolves off `homedir()`, so HOME is repointed to a tmp
 * dir BEFORE importing the module under test. FRIDAY_DATA_DIR is also set
 * before any @friday/shared import (data-dir binding rule).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { DownloadProgress, UpdateDeps, UpdateReporter } from "./update.js";
import { ensureBrewDeps, BREW_DEPS } from "../lib/brew-deps.js";

// Repoint HOME + data dir to scratch tmp BEFORE importing anything that
// resolves install paths or @friday/shared data-dir constants.
const HOME = mkdtempSync(join(tmpdir(), "friday-update-home-"));
process.env.HOME = HOME;
process.env.FRIDAY_DATA_DIR = join(HOME, ".friday");

const {
  runUpdate,
  flipCurrent,
  currentVersion,
  installedVersion,
  installedVersions,
  assertValidVersion,
  compareVersions,
  assetTagForArch,
  defaultUpdateDeps,
} = await import("./update.js");
const { installRoot, versionsDir, versionDir, currentLink } =
  await import("../lib/install-paths.js");

/** Lay down a `versions/<v>/` dir with a root package.json carrying that
 *  version. Returns the dir. */
function plantVersion(version: string): string {
  const dir = versionDir(version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "agent-friday", version }));
  return dir;
}

/** A stub UpdateDeps whose downloadRelease writes a tarball-shaped file plus
 *  a matching `.sha256`, and whose extract plants a package.json carrying
 *  `latestVersion`. bootstrap is a spy — it stands in for launchd.bootstrap,
 *  which rewrites the plist + boots-or-kickstarts the supervisor.
 *
 *  Dep-preflight: `provision` is a spy standing in for exec'ing the NEW
 *  binary's `friday provision` (it returns an exit code). Every call-order-
 *  sensitive step (provision, bootstrap, the flip's proxy) pushes its name onto
 *  a shared `calls` array so a test can assert the load-bearing ordering
 *  (flip → provision → restart) and the rollback-on-provision-failure path. */
function makeDeps(opts: {
  latestVersion: string;
  /** When true, the .sha256 won't match the tarball (tamper simulation). */
  corruptSha?: boolean;
  /** Whether the supervisor is "running" before the update. Default true
   *  (the common case); set false to exercise the stopped-stays-stopped path. */
  running?: boolean;
  /** Whether the launchd plist is on disk (autostart armed). Default true; set
   *  false to model a `friday disable`d box (update must not resurrect it). */
  plistExists?: boolean;
  /** Exit code the exec'd `friday provision` returns. Default 0 (success);
   *  non-zero drives the rollback-without-restart path. */
  provisionCode?: number;
}): {
  deps: UpdateDeps;
  bootstrap: ReturnType<typeof vi.fn>;
  writePlist: ReturnType<typeof vi.fn>;
  provision: ReturnType<typeof vi.fn>;
  /** Ordered record of the flip/provision/restart steps, in call order. */
  calls: string[];
} {
  const calls: string[] = [];
  const bootstrap = vi.fn(() => {
    calls.push("bootstrap");
  });
  const writePlist = vi.fn(() => {
    calls.push("writePlist");
  });
  const provision = vi.fn(() => {
    // The flip has already happened by the time provision runs (it execs the
    // NEW binary), so record the current symlink target to prove ordering.
    calls.push(`provision:${currentVersion()}`);
    return opts.provisionCode ?? 0;
  });
  const deps: UpdateDeps = {
    resolveLatestVersion: async () => opts.latestVersion,
    downloadRelease: async (destDir: string) => {
      const tarball = join(destDir, "friday-darwin-arm64.tar.gz");
      const sha = join(destDir, "friday-darwin-arm64.tar.gz.sha256");
      // A deterministic payload; its real sha256 is computed by the command.
      writeFileSync(tarball, `tarball-for-${opts.latestVersion}`);
      // The command computes the actual sha256 of the tarball; to make the
      // happy path pass we write the matching digest, and to simulate tamper
      // we write a wrong one.
      const { createHash } = await import("node:crypto");
      const real = createHash("sha256").update(readFileSync(tarball)).digest("hex");
      writeFileSync(sha, opts.corruptSha ? "0".repeat(64) + "\n" : real + "\n");
      return { tarball, sha };
    },
    extract: (_tarball: string, destDir: string) => {
      // Simulate the extracted tree: a root package.json at the version.
      writeFileSync(
        join(destDir, "package.json"),
        JSON.stringify({ name: "agent-friday", version: opts.latestVersion }),
      );
    },
    fnmInstall: () => {
      calls.push("fnmInstall");
    },
    bootstrap,
    isRunning: () => opts.running ?? true,
    plistExists: () => opts.plistExists ?? true,
    writePlist,
    provision,
  };
  return {
    deps,
    bootstrap,
    writePlist,
    provision,
    calls,
  };
}

/** A reporter that records every emitted event as a `kind:message` string so
 *  tests can assert the user-facing flow without scraping stdout. progress
 *  ticks are captured separately for the download-UX assertions. */
function recordingReporter(): {
  reporter: UpdateReporter;
  events: string[];
  ticks: DownloadProgress[];
} {
  const events: string[] = [];
  const ticks: DownloadProgress[] = [];
  const reporter: UpdateReporter = {
    step: (m) => events.push(`step:${m}`),
    note: (m) => events.push(`note:${m}`),
    progress: (p) => ticks.push({ ...p }),
    endProgress: () => events.push("endProgress"),
    spinner: (label) => {
      events.push(`spinner:${label}`);
      return {
        done: (m) => events.push(`spinner-done:${m}`),
        skip: (m) => events.push(`spinner-skip:${m}`),
        fail: (m) => events.push(`spinner-fail:${m}`),
      };
    },
    success: (m) => events.push(`success:${m}`),
    warn: (m) => events.push(`warn:${m}`),
  };
  return { reporter, events, ticks };
}

describe("friday update", () => {
  beforeEach(() => {
    rmSync(installRoot(), { recursive: true, force: true });
    mkdirSync(versionsDir(), { recursive: true });
  });

  afterEach(() => {
    rmSync(installRoot(), { recursive: true, force: true });
  });

  it("flips current forward to the new version, keeping the prior dir (AC#4)", async () => {
    // Start: current → versions/A.
    plantVersion("1.0.0");
    flipCurrent("1.0.0");
    expect(currentVersion()).toBe("1.0.0");

    const { deps, bootstrap } = makeDeps({ latestVersion: "1.1.0" });
    const { reporter, events } = recordingReporter();
    await runUpdate({}, deps, reporter);

    // current now → versions/1.1.0; the prior 1.0.0 dir still exists.
    expect(basename(readlinkSync(currentLink()))).toBe("1.1.0");
    expect(currentVersion()).toBe("1.1.0");
    expect(existsSync(versionDir("1.0.0"))).toBe(true);
    expect(existsSync(versionDir("1.1.0"))).toBe(true);
    // The freshly-extracted tree's package.json carries the new version.
    expect(installedVersion()).toBe("1.1.0");
    // Supervisor was kicked.
    expect(bootstrap).toHaveBeenCalledTimes(1);

    // The user-facing flow narrates every step, in order, ending in success —
    // download is bracketed by endProgress (the live-bar finalizer), and the
    // success line names the new version. Dep-preflight: the flip happens
    // FIRST ("Switching to new version…") so the provision step execs the NEW
    // binary, then the restart. The brew/extension/model TUI now lives inside
    // `friday provision` (see provision.test.ts), not the update narration.
    expect(events).toEqual([
      "step:Checking for the latest release…",
      expect.stringMatching(/^step:Updating 1\.0\.0 → .*1\.1\.0/),
      "step:Downloading update…",
      "endProgress",
      "step:Verifying checksum…",
      expect.stringMatching(/^note:checksum verified \(/),
      "step:Extracting…",
      "step:Provisioning Node runtime…",
      "step:Switching to new version…",
      "step:Provisioning dependencies…",
      "step:Restarting Friday…",
      expect.stringMatching(/^success:Updated to 1\.1\.0 /),
    ]);
  });

  it("update while Friday is STOPPED refreshes the plist but does NOT restart it", async () => {
    plantVersion("1.0.0");
    flipCurrent("1.0.0");

    const { deps, bootstrap, writePlist } = makeDeps({ latestVersion: "1.1.0", running: false });
    const { reporter, events } = recordingReporter();
    await runUpdate({}, deps, reporter);

    // Still updated to the new version…
    expect(currentVersion()).toBe("1.1.0");
    // …but the supervisor was NOT started (user had it stopped), and the plist
    // was refreshed so the next `friday start` / reboot picks up the new version.
    expect(bootstrap).not.toHaveBeenCalled();
    expect(writePlist).toHaveBeenCalledTimes(1);
    // Narration reflects in-place update, not a restart.
    expect(events).not.toContain("step:Restarting Friday…");
    expect(events).toContainEqual(expect.stringMatching(/^step:Friday was stopped/));
  });

  it("rollback while Friday is STOPPED does not restart it either", async () => {
    plantVersion("1.0.0");
    plantVersion("1.1.0");
    flipCurrent("1.1.0");

    const { deps, bootstrap, writePlist } = makeDeps({ latestVersion: "1.1.0", running: false });
    const { reporter } = recordingReporter();
    await runUpdate({ rollback: true }, deps, reporter);

    expect(currentVersion()).toBe("1.0.0"); // rolled back
    expect(bootstrap).not.toHaveBeenCalled();
    expect(writePlist).toHaveBeenCalledTimes(1);
  });

  it("update while Friday is DISABLED (plist removed) does NOT resurrect the plist", async () => {
    plantVersion("1.0.0");
    flipCurrent("1.0.0");

    // `friday disable`d box: stopped AND no plist on disk.
    const { deps, bootstrap, writePlist } = makeDeps({
      latestVersion: "1.1.0",
      running: false,
      plistExists: false,
    });
    const { reporter, events } = recordingReporter();
    await runUpdate({}, deps, reporter);

    // Updated, but neither started NOR plist-rewritten — autostart stays off.
    expect(currentVersion()).toBe("1.1.0");
    expect(bootstrap).not.toHaveBeenCalled();
    expect(writePlist).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.stringMatching(/^step:Friday is disabled/));
  });

  it("rolls back to the immediately-prior version + kickstarts (AC#5)", async () => {
    // Build the post-forward state: A present, current → B.
    plantVersion("1.0.0");
    plantVersion("1.1.0");
    flipCurrent("1.1.0");
    expect(currentVersion()).toBe("1.1.0");

    const { deps, bootstrap } = makeDeps({ latestVersion: "1.1.0" });
    await runUpdate({ rollback: true }, deps);

    expect(currentVersion()).toBe("1.0.0");
    expect(basename(readlinkSync(currentLink()))).toBe("1.0.0");
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("rollback picks the semver-prior version regardless of plant/mtime order (AC#5)", async () => {
    // Plant OUT of semver order (and thus out of mtime order): the newest dir
    // by mtime is 1.0.0, but rollback must follow semver precedence, not mtime.
    // This is the regression the mtime-ordering bug would have caused — picking
    // 1.0.5 (older mtime) or mis-ordering when a prior dir was re-touched.
    plantVersion("1.2.0");
    plantVersion("1.0.0");
    plantVersion("1.10.0"); // 1.10.0 > 1.2.0 by semver, < by lexicographic
    flipCurrent("1.10.0");
    expect(currentVersion()).toBe("1.10.0");

    const { deps, bootstrap } = makeDeps({ latestVersion: "1.10.0" });
    await runUpdate({ rollback: true }, deps);

    // Semver-prior to 1.10.0 is 1.2.0 (not 1.0.0, not a lexicographic neighbor).
    expect(currentVersion()).toBe("1.2.0");
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("rollback with no prior version exits non-zero naming the missing version (AC#5)", async () => {
    // Only one version installed; nothing to roll back to.
    plantVersion("1.0.0");
    flipCurrent("1.0.0");

    const { deps, bootstrap } = makeDeps({ latestVersion: "1.0.0" });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(runUpdate({ rollback: true }, deps)).rejects.toThrow("process.exit(1)");
      expect(bootstrap).not.toHaveBeenCalled();
      // The error message names the current version (the one we can't go
      // back from) — load-bearing per AC#5.
      const msg = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msg).toContain("1.0.0");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("--check is read-only: prints both, flips nothing, creates no version (AC#6)", async () => {
    plantVersion("1.0.0");
    flipCurrent("1.0.0");

    const { deps, bootstrap } = makeDeps({ latestVersion: "2.0.0" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let out: string;
    try {
      await runUpdate({ check: true }, deps);
      // Snapshot the captured output BEFORE restoring — mockRestore() clears
      // the recorded calls.
      out = logSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    } finally {
      logSpy.mockRestore();
    }

    // Symlink unchanged, no new version dir, no kickstart.
    expect(currentVersion()).toBe("1.0.0");
    expect(existsSync(versionDir("2.0.0"))).toBe(false);
    expect(installedVersions()).toEqual(["1.0.0"]);
    expect(bootstrap).not.toHaveBeenCalled();
    // Both versions surfaced.
    expect(out).toContain("1.0.0");
    expect(out).toContain("2.0.0");
  });

  it("aborts on sha256 mismatch, leaving no new versions/<v> dir and no flip (AC#3)", async () => {
    plantVersion("1.0.0");
    flipCurrent("1.0.0");

    const { deps, bootstrap } = makeDeps({ latestVersion: "1.2.0", corruptSha: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(runUpdate({}, deps)).rejects.toThrow(/sha256 mismatch/);
    } finally {
      logSpy.mockRestore();
    }

    // No partial install, no flip, no restart.
    expect(existsSync(versionDir("1.2.0"))).toBe(false);
    expect(currentVersion()).toBe("1.0.0");
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("no-ops when already on the latest version (AC#4 idempotence)", async () => {
    plantVersion("3.0.0");
    flipCurrent("3.0.0");

    const { deps, bootstrap } = makeDeps({ latestVersion: "3.0.0" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runUpdate({}, deps);
    } finally {
      logSpy.mockRestore();
    }
    expect(currentVersion()).toBe("3.0.0");
    expect(bootstrap).not.toHaveBeenCalled();
  });
});

describe("flipCurrent — atomic relative symlink", () => {
  beforeEach(() => {
    rmSync(installRoot(), { recursive: true, force: true });
    mkdirSync(versionsDir(), { recursive: true });
  });
  afterEach(() => rmSync(installRoot(), { recursive: true, force: true }));

  it("replaces an existing current symlink in place", () => {
    plantVersion("1.0.0");
    plantVersion("1.1.0");
    flipCurrent("1.0.0");
    expect(currentVersion()).toBe("1.0.0");
    flipCurrent("1.1.0");
    expect(currentVersion()).toBe("1.1.0");
  });

  it("writes the target as a relative path (relocatable tree)", () => {
    plantVersion("1.0.0");
    flipCurrent("1.0.0");
    const target = readlinkSync(currentLink());
    expect(target).toBe(join("versions", "1.0.0"));
    expect(target.startsWith("/")).toBe(false);
  });
});

describe("assertValidVersion — path-traversal gate (security)", () => {
  it("accepts strict semver, with optional v-prefix / pre-release / build", () => {
    for (const v of ["0.1.0", "1.2.3", "v1.2.3", "10.20.30", "1.0.0-rc.1", "1.0.0+build.5"]) {
      expect(assertValidVersion(v)).toBe(v);
    }
  });

  it("rejects path-traversal and non-semver payloads", () => {
    for (const v of [
      "../../../tmp/x",
      "1.0.0/../../foo",
      "1.0.0/etc",
      "..",
      "/abs/path",
      "1.0",
      "latest",
      "",
      "1.0.0 rm -rf",
    ]) {
      expect(() => assertValidVersion(v), `expected reject: ${JSON.stringify(v)}`).toThrow(
        /not a valid semver/,
      );
    }
  });
});

describe("friday update — rejects an untrusted resolved version before touching the FS (security)", () => {
  beforeEach(() => {
    rmSync(installRoot(), { recursive: true, force: true });
    mkdirSync(versionsDir(), { recursive: true });
  });
  afterEach(() => rmSync(installRoot(), { recursive: true, force: true }));

  it("a traversal VERSION payload throws and creates no escaped dir, no flip", async () => {
    plantVersion("1.0.0");
    flipCurrent("1.0.0");

    // A compromised/typo'd VERSION asset that would escape versions/.
    const bootstrap = vi.fn();
    const malicious: UpdateDeps = {
      resolveLatestVersion: async () => "../../../tmp/pwned",
      downloadRelease: async () => {
        throw new Error("download must never be reached for an invalid version");
      },
      extract: () => {
        throw new Error("extract must never be reached for an invalid version");
      },
      fnmInstall: () => {},
      bootstrap,
      isRunning: () => true,
      plistExists: () => true,
      writePlist: vi.fn(),
      provision: vi.fn(() => 0),
    };

    await expect(runUpdate({}, malicious)).rejects.toThrow(/not a valid semver/);

    // The forward path bailed BEFORE download/extract/flip: symlink unchanged,
    // no escaped dir under the install root, no restart.
    expect(currentVersion()).toBe("1.0.0");
    expect(existsSync(join(installRoot(), "..", "..", "tmp", "pwned"))).toBe(false);
    expect(existsSync(versionDir("../../../tmp/pwned"))).toBe(false);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("--check also rejects an untrusted resolved version", async () => {
    plantVersion("1.0.0");
    flipCurrent("1.0.0");
    const malicious: UpdateDeps = {
      resolveLatestVersion: async () => "1.0.0/../../foo",
      downloadRelease: async () => ({ tarball: "", sha: "" }),
      extract: () => {},
      fnmInstall: () => {},
      bootstrap: vi.fn(),
      isRunning: () => true,
      plistExists: () => true,
      writePlist: vi.fn(),
      provision: vi.fn(() => 0),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(runUpdate({ check: true }, malicious)).rejects.toThrow(/not a valid semver/);
    } finally {
      logSpy.mockRestore();
    }
    expect(currentVersion()).toBe("1.0.0");
  });
});

describe("assetTagForArch — per-arch release-asset naming", () => {
  it("maps the two shipped darwin arches to their tags", () => {
    expect(assetTagForArch("darwin", "arm64")).toBe("darwin-arm64");
    expect(assetTagForArch("darwin", "x64")).toBe("darwin-x64");
  });

  it("throws for arches/platforms Friday does not build (no wrong-arch self-update)", () => {
    for (const [platform, arch] of [
      ["darwin", "ia32"],
      ["darwin", "ppc64"],
      ["linux", "x64"],
      ["linux", "arm64"],
      ["win32", "x64"],
    ] as const) {
      expect(() => assetTagForArch(platform, arch)).toThrow(/unsupported platform/);
    }
  });
});

describe("defaultUpdateDeps.downloadRelease — per-arch asset URLs (cross-boundary wiring)", () => {
  const ORIG_ARCH = process.arch;
  const ORIG_PLATFORM = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "arch", { value: ORIG_ARCH, configurable: true });
    Object.defineProperty(process, "platform", { value: ORIG_PLATFORM, configurable: true });
    vi.unstubAllGlobals();
  });

  // Pins the load-bearing URL the feature exists for: an Intel box MUST fetch
  // friday-darwin-x64.tar.gz, not the arm64 one (the diff's whole rationale —
  // wrong-arch addons crash-loop the supervisor). Every runUpdate test stubs
  // downloadRelease out, so ONLY this drives the real assetNames() -> URL
  // composition. platform is forced to darwin because the suite runs on linux
  // CI, where assetTagForArch (correctly) throws.
  for (const [arch, tag] of [
    ["arm64", "darwin-arm64"],
    ["x64", "darwin-x64"],
  ] as const) {
    it(`fetches friday-${tag}.tar.gz + its .sha256 when process.arch is ${arch}`, async () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      Object.defineProperty(process, "arch", { value: arch, configurable: true });

      const urls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          urls.push(String(url));
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new ArrayBuffer(8),
          } as unknown as Response;
        }),
      );

      const dest = mkdtempSync(join(tmpdir(), "friday-dl-"));
      try {
        const { tarball, sha } = await defaultUpdateDeps.downloadRelease(dest);
        const base = "https://github.com/sethvoltz/friday/releases/latest/download";
        // Exact URLs, in order: tarball then its .sha256 — not just a substring.
        expect(urls).toEqual([
          `${base}/friday-${tag}.tar.gz`,
          `${base}/friday-${tag}.tar.gz.sha256`,
        ]);
        // Returned paths carry the arch-correct filenames.
        expect(basename(tarball)).toBe(`friday-${tag}.tar.gz`);
        expect(basename(sha)).toBe(`friday-${tag}.tar.gz.sha256`);
      } finally {
        rmSync(dest, { recursive: true, force: true });
      }
    });
  }
});

describe("defaultUpdateDeps.downloadRelease — streaming progress (download UX)", () => {
  const ORIG_ARCH = process.arch;
  const ORIG_PLATFORM = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "arch", { value: ORIG_ARCH, configurable: true });
    Object.defineProperty(process, "platform", { value: ORIG_PLATFORM, configurable: true });
    vi.unstubAllGlobals();
  });

  // The headline feature: the tarball is streamed to disk and progress ticks
  // fire as bytes arrive (monotonic, carrying the server's Content-Length and
  // landing exactly at total), while the full payload is written byte-for-byte.
  // Stateful behavior → stateful test, mocking only the fetch boundary.
  it("streams the tarball with monotonic progress and writes every byte", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    Object.defineProperty(process, "arch", { value: "x64", configurable: true });

    const chunks = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8, 9, 10])];
    const total = 10;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(".sha256")) {
          // Tiny asset: no stream, exercise the buffered fallback path.
          const sha = new TextEncoder().encode("deadbeef  friday-darwin-x64.tar.gz\n");
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            arrayBuffer: async () => sha.buffer,
          } as unknown as Response;
        }
        // Tarball: a real web ReadableStream + Content-Length, like GitHub's CDN.
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            for (const ch of chunks) c.enqueue(ch);
            c.close();
          },
        });
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-length": String(total) }),
          body,
        } as unknown as Response;
      }),
    );

    const ticks: DownloadProgress[] = [];
    const dest = mkdtempSync(join(tmpdir(), "friday-dl-"));
    try {
      const { tarball } = await defaultUpdateDeps.downloadRelease(dest, (p) =>
        ticks.push({ ...p }),
      );

      // Progress fires only for the tarball, never the silent .sha256.
      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks.every((t) => t.asset === "friday-darwin-x64.tar.gz")).toBe(true);
      // Downloaded count is non-decreasing and surfaces the real total.
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i].downloaded).toBeGreaterThanOrEqual(ticks[i - 1].downloaded);
      }
      expect(ticks.every((t) => t.total === total)).toBe(true);
      // The final tick lands exactly at total (drives the bar to 100%).
      expect(ticks[ticks.length - 1].downloaded).toBe(total);

      // The file on disk is the full payload, byte-for-byte.
      const written = readFileSync(tarball);
      expect(written.length).toBe(total);
      expect([...written]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe("compareVersions — semver precedence (AC#5 ordering)", () => {
  it("orders by major.minor.patch numerically, not lexicographically", () => {
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0); // 1.10 > 1.2
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.2.0")).toBeLessThan(0);
  });

  it("ranks a pre-release below its matching release", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.2")).toBeLessThan(0);
  });

  it("ignores v-prefix and build metadata for precedence", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3+build.9", "1.2.3+build.1")).toBe(0);
  });
});

describe("installedVersions — semver-ordered, mtime-independent (AC#5)", () => {
  beforeEach(() => {
    rmSync(installRoot(), { recursive: true, force: true });
    mkdirSync(versionsDir(), { recursive: true });
  });
  afterEach(() => rmSync(installRoot(), { recursive: true, force: true }));

  it("returns dirs in ascending semver order regardless of plant (mtime) order", () => {
    // Plant in an order that is neither semver nor reverse-semver.
    plantVersion("1.10.0");
    plantVersion("1.2.0");
    plantVersion("1.0.0");
    plantVersion("2.0.0");
    expect(installedVersions()).toEqual(["1.0.0", "1.2.0", "1.10.0", "2.0.0"]);
  });
});

describe("friday update — provision-after-flip + rollback (dep-preflight)", () => {
  beforeEach(() => {
    rmSync(installRoot(), { recursive: true, force: true });
    mkdirSync(versionsDir(), { recursive: true });
  });
  afterEach(() => rmSync(installRoot(), { recursive: true, force: true }));

  it("flips FIRST, then execs the NEW binary's provision, then restarts", async () => {
    plantVersion("1.0.0");
    flipCurrent("1.0.0");

    const { deps, bootstrap, provision, calls } = makeDeps({ latestVersion: "1.1.0" });
    const { reporter } = recordingReporter();
    await runUpdate({}, deps, reporter);

    // provision ran exactly once, and ran AFTER the flip — the `provision:`
    // marker records the live `current` target at call time, which must be the
    // NEW version (proving the exec'd binary is the new one, not the outgoing).
    expect(provision).toHaveBeenCalledTimes(1);
    const ordered = calls.filter((c) => c.startsWith("provision:") || c === "bootstrap");
    expect(ordered).toEqual(["provision:1.1.0", "bootstrap"]);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(currentVersion()).toBe("1.1.0");
  });

  it("rolls back the flip and does NOT restart when provision fails", async () => {
    plantVersion("1.0.0");
    flipCurrent("1.0.0");

    const { deps, bootstrap, provision, calls } = makeDeps({
      latestVersion: "1.1.0",
      provisionCode: 1,
    });
    const { reporter, events } = recordingReporter();

    await expect(runUpdate({}, deps, reporter)).rejects.toThrow(/provisioning failed \(exit 1\)/);

    // provision was attempted (after the flip), but the failure rolled `current`
    // back to the last-known-good version and never restarted the daemon — so a
    // box is never left running an unprovisioned tree.
    expect(provision).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain("bootstrap");
    expect(bootstrap).not.toHaveBeenCalled();
    expect(currentVersion()).toBe("1.0.0"); // rolled back
    // The new tree stays extracted for a retry.
    expect(existsSync(versionDir("1.1.0"))).toBe(true);
    // The operator is told how to recover.
    expect(events).toContainEqual(expect.stringMatching(/^warn:provisioning failed .*rolled back/));
  });

  it("also provisions on the already-downloaded reuse path", async () => {
    plantVersion("1.0.0");
    flipCurrent("1.0.0");
    plantVersion("1.1.0");

    const { deps, provision, bootstrap, calls } = makeDeps({ latestVersion: "1.1.0" });
    const { reporter } = recordingReporter();
    await runUpdate({}, deps, reporter);

    expect(currentVersion()).toBe("1.1.0");
    expect(provision).toHaveBeenCalledTimes(1);
    const ordered = calls.filter((c) => c.startsWith("provision:") || c === "bootstrap");
    expect(ordered).toEqual(["provision:1.1.0", "bootstrap"]);
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("on a fresh box (no prior version) a failed provision stages but does not start", async () => {
    // No prior version planted — `current` doesn't exist before the update.
    const { deps, bootstrap, calls } = makeDeps({ latestVersion: "1.1.0", provisionCode: 2 });
    const { reporter, events } = recordingReporter();

    await expect(runUpdate({}, deps, reporter)).rejects.toThrow(/provisioning failed \(exit 2\)/);

    // Nothing to roll back to → the new version stays flipped-in (staged) but
    // the daemon is never started into it.
    expect(calls).not.toContain("bootstrap");
    expect(bootstrap).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.stringMatching(/^warn:provisioning failed .*staged/));
  });
});

describe("ensureBrewDeps — idempotent reconcile (FRI-24)", () => {
  it("installs only the missing deps and SKIPS ones brew already has", () => {
    // Model a host that already has every dep EXCEPT pgvector (the FRI-24
    // addition): only pgvector should be `brew install`ed, everything else
    // skipped (the idempotent path).
    const installed: string[] = [];
    const has = (dep: string): boolean => dep !== "pgvector";
    const install = (dep: string): boolean => {
      installed.push(dep);
      return true;
    };

    const result = ensureBrewDeps({ has, install });

    // Exactly pgvector installed; the rest reported already-present.
    expect(installed).toEqual(["pgvector"]);
    expect(result.installed).toEqual(["pgvector"]);
    expect(result.alreadyPresent).toEqual(BREW_DEPS.filter((d) => d !== "pgvector"));
    expect(result.failed).toEqual([]);
  });

  it("triggers NO brew install when every dep (incl. pgvector) is present", () => {
    // The pure idempotent re-run: a host that already has pgvector must not
    // shell out to `brew install` at all.
    const installCalls: string[] = [];
    const result = ensureBrewDeps({
      has: () => true,
      install: (dep) => {
        installCalls.push(dep);
        return true;
      },
    });

    expect(installCalls).toEqual([]);
    expect(result.installed).toEqual([]);
    expect(result.alreadyPresent).toEqual([...BREW_DEPS]);
    expect(result.failed).toEqual([]);
  });

  it("records a failed brew install in `failed` without throwing", () => {
    // install.sh's `|| warn` semantics: a failed install is recorded, not
    // fatal. pgvector missing + its install failing surfaces in `failed`.
    const result = ensureBrewDeps({
      has: (dep) => dep !== "pgvector",
      install: () => false,
    });
    expect(result.failed).toEqual(["pgvector"]);
    expect(result.installed).toEqual([]);
  });
});
