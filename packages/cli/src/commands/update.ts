/**
 * `friday update` — download + verify + extract + symlink-flip + restart
 * (FRI-146 / ADR-034). The rustup-`self update` model: Friday installs into
 * self-owned versioned dirs (`~/.local/share/friday/versions/<v>/`) that
 * only this command ever flips, so brew (or anything else) can never swap a
 * dir under a live process again.
 *
 *   friday update            resolve latest; if current, no-op; else
 *                            download + sha256-verify + fnm install +
 *                            extract + flip `current` + kickstart.
 *   friday update --check    report installed vs available; change nothing.
 *   friday update --rollback flip `current` back to the prior version dir +
 *                            kickstart; error if no prior version.
 *
 * Asset names are per-arch — `friday-darwin-arm64.tar.gz` (Apple Silicon,
 * primary) or `friday-darwin-x64.tar.gz` (Intel, legacy) — plus a matching
 * `.tar.gz.sha256` and the shared `VERSION`. The arch is the RUNNING machine's
 * (`process.arch`), so an Intel box pulls the Intel tarball: fetching the wrong
 * arch would land ABI-mismatched native addons and crash-loop the supervisor.
 * Resolution is via GitHub's release-asset redirect
 * (`releases/latest/download/<asset>`) — no auth, no JSON parsing.
 *
 * The network + filesystem-extract + launchctl steps are injected via the
 * `UpdateDeps` seam so unit tests exercise the flip/rollback/verify logic
 * against scratch tmp dirs without hitting the network or real launchctl.
 *
 * User-facing output goes through the `UpdateReporter` seam: the forward
 * update narrates each step (resolve → download → verify → extract → provision
 * → restart) and renders a live download bar (percent / size / speed / ETA) on
 * a TTY, degrading to plain lines when piped. Tests pass a recording reporter
 * and assert on the emitted steps rather than scraping stdout.
 */

import { defineCommand } from "citty";
import pc from "picocolors";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as launchd from "../lib/launchd.js";
import { currentLink, versionDir, versionsDir } from "../lib/install-paths.js";

const RELEASE_BASE = "https://github.com/sethvoltz/friday/releases/latest/download";

/**
 * The release-asset platform tag for the RUNNING machine, mirroring
 * `pack.mjs:platformTag()`. Friday ships `darwin-arm64` (Apple Silicon,
 * primary) and `darwin-x64` (Intel, legacy). Exported so the unit suite can
 * pin both arches without spawning under each one. Throws on anything else —
 * `friday update` must never resolve an asset name for an arch we don't build.
 */
export function assetTagForArch(platform: string, arch: string): string {
  const archTag = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (platform !== "darwin" || !archTag) {
    throw new Error(
      `unsupported platform ${platform}-${arch} — Friday ships darwin-arm64 (Apple Silicon) and darwin-x64 (Intel)`,
    );
  }
  return `${platform}-${archTag}`;
}

const VERSION_NAME = "VERSION";

/**
 * The tarball + `.sha256` asset names for the RUNNING machine. Resolved
 * lazily (at download time, not module load) so importing this module is
 * side-effect-free on platforms Friday doesn't build — the unit suite runs on
 * Linux CI, where a module-level {@link assetTagForArch} call would throw and
 * sink every test in the file. The throw still fires if a real `friday update`
 * is attempted on an unsupported arch, which is the correct outcome.
 */
function assetNames(): { tarball: string; sha: string } {
  const tag = assetTagForArch(process.platform, process.arch);
  const tarball = `friday-${tag}.tar.gz`;
  return { tarball, sha: `${tarball}.sha256` };
}

/**
 * Strict semver shape for a release version: `MAJOR.MINOR.PATCH` with an
 * optional `v` prefix and optional pre-release / build metadata. This is the
 * gate that keeps a remote-fetched `VERSION` payload from ever becoming a
 * path segment: the resolved string flows into `versionDir(version)` /
 * `flipCurrent(version)` (which `join(...)` + `symlinkSync(...)` it into the
 * install root), so a payload like `../../../tmp/x` would otherwise escape
 * the versions/ dir and point the `current` symlink — then the
 * launchd-executed tree — at an arbitrary path. `.trim()` strips whitespace
 * but NOT `/` or `..`; this regex rejects both. `install.sh`'s
 * `resolve_version` enforces the same shape in bash.
 */
const VERSION_RE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Validate a resolved version string against {@link VERSION_RE} BEFORE it is
 * ever joined into a filesystem path. Throws on mismatch. Exported so the
 * unit suite can pin the rejection of traversal payloads.
 */
export function assertValidVersion(version: string): string {
  if (!VERSION_RE.test(version)) {
    throw new Error(
      `refusing to use untrusted version string "${version}" — not a valid semver release version`,
    );
  }
  return version;
}

/**
 * Compare two version strings by semver precedence (returns <0, 0, or >0).
 * The version dir names are already validated strict semver, so we compare
 * MAJOR.MINOR.PATCH numerically; a pre-release (`-rc.1`) sorts BELOW the
 * matching release per semver §11. We don't need full pre-release-field
 * precedence (release dirs are the common case) — a pre-release simply ranks
 * just under its release. The optional `v` prefix and `+build` metadata are
 * stripped (build metadata is ignored for precedence per semver §10).
 *
 * Semver ordering is used instead of directory mtime because mtime is a
 * fragile proxy for install order: a tar re-extract, filesystem restore, or
 * rsync touches a prior version dir's mtime and would reorder the sequence,
 * flipping `--rollback` to the wrong version. The dir names ARE the semver
 * truth, so we sort by them directly.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { core: [number, number, number]; pre: string | null } => {
    const body = v.replace(/^v/, "").split("+", 1)[0]; // drop v-prefix + build metadata
    const dash = body.indexOf("-");
    const core = (dash === -1 ? body : body.slice(0, dash)).split(".").map((n) => Number(n));
    const pre = dash === -1 ? null : body.slice(dash + 1);
    return { core: [core[0] ?? 0, core[1] ?? 0, core[2] ?? 0], pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  }
  // Equal core: a release (no pre) outranks a pre-release of the same core.
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
}

/**
 * A single download-progress tick. `total` is null when the server sent no
 * `Content-Length` (the bar then degrades to a byte counter + speed).
 */
export interface DownloadProgress {
  /** The asset filename being downloaded (e.g. `friday-darwin-arm64.tar.gz`). */
  asset: string;
  /** Bytes received so far. */
  downloaded: number;
  /** Total bytes if the server advertised them, else null. */
  total: number | null;
}

/**
 * Injectable user-facing output surface, so `runUpdate` can narrate the
 * multi-step flow (resolve → download → verify → extract → provision → restart)
 * with a live download bar — while tests pass a recording/silent reporter and
 * assert on the emitted events instead of scraping stdout. The default
 * {@link createConsoleReporter} renders a redrawing progress line on a TTY and
 * degrades to plain lines when piped.
 */
export interface UpdateReporter {
  /** A discrete step is starting (printed with a leading arrow). */
  step(message: string): void;
  /** A dim sub-note under the current step (e.g. a verified checksum). */
  note(message: string): void;
  /** A download-progress tick — drives the live bar. */
  progress(p: DownloadProgress): void;
  /** Finalize any in-flight progress line (writes the trailing newline). */
  endProgress(): void;
  /** Terminal success line. */
  success(message: string): void;
  /** Non-fatal warning line. */
  warn(message: string): void;
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m${String(s).padStart(2, "0")}s`;
  }
  return `${Math.ceil(seconds)}s`;
}

function progressBar(fraction: number, width = 22): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function elapsedSince(startMs: number): string {
  return pc.dim(`(in ${((Date.now() - startMs) / 1000).toFixed(1)}s)`);
}

/**
 * The default reporter: a redrawing single-line download bar (percent, size,
 * speed, ETA) on a TTY; plain step lines + a one-shot completion line when
 * piped. Carries the per-download timing/throttle state so progress() is a
 * flat callback the download layer can fire freely. Mirrors the codebase's
 * picocolors glyph convention and `process.stdout.isTTY === true` gate
 * (see doctor.ts:LiveBox).
 */
export function createConsoleReporter(): UpdateReporter {
  const tty = process.stdout.isTTY === true;
  let dlAsset: string | null = null;
  let dlStart = 0;
  let lastRender = 0;
  let lineOpen = false;

  const closeLine = () => {
    if (lineOpen && tty) process.stdout.write("\n");
    lineOpen = false;
  };

  return {
    step(message) {
      closeLine();
      console.log(`${pc.cyan("→")} ${message}`);
    },
    note(message) {
      closeLine();
      console.log(pc.dim(`  ${message}`));
    },
    progress({ asset, downloaded, total }) {
      if (asset !== dlAsset) {
        closeLine();
        dlAsset = asset;
        dlStart = Date.now();
        lastRender = 0;
      }
      const now = Date.now();
      const isFinal = total != null && downloaded >= total;
      // Throttle redraws to keep the bar smooth without spamming the terminal;
      // always render the final frame so the line lands at 100%.
      if (!isFinal && now - lastRender < 90) return;
      lastRender = now;

      const elapsed = (now - dlStart) / 1000;
      const speed = elapsed > 0 ? downloaded / elapsed : 0;
      let line: string;
      if (total != null && total > 0) {
        const frac = downloaded / total;
        const eta = speed > 0 ? (total - downloaded) / speed : Infinity;
        line =
          `  ${pc.cyan(asset)}  ${progressBar(frac)} ${String(Math.floor(frac * 100)).padStart(3)}%  ` +
          `${fmtBytes(downloaded)}/${fmtBytes(total)}  ${fmtBytes(speed)}/s  eta ${fmtEta(eta)}`;
      } else {
        line = `  ${pc.cyan(asset)}  ${fmtBytes(downloaded)}  ${fmtBytes(speed)}/s`;
      }

      if (tty) {
        // \r to column 0, \x1b[2K to clear the whole line, then repaint.
        process.stdout.write(`\r\x1b[2K${line}`);
        lineOpen = true;
        if (isFinal) closeLine();
      } else if (isFinal) {
        // Piped: no live bar — emit a single completion line.
        console.log(`  downloaded ${asset} (${fmtBytes(downloaded)})`);
      }
    },
    endProgress() {
      closeLine();
    },
    success(message) {
      closeLine();
      console.log(pc.green(`✔ ${message}`));
    },
    warn(message) {
      closeLine();
      console.log(pc.yellow(`⚠ ${message}`));
    },
  };
}

/**
 * Injectable side-effect surface. The default implementation hits the real
 * network / filesystem / launchctl; tests pass stubs.
 */
export interface UpdateDeps {
  /** Fetch the latest published version string (the `VERSION` asset). */
  resolveLatestVersion(): Promise<string>;
  /** Download the tarball + its `.sha256` into `destDir`. Returns the
   *  absolute paths of each. `onProgress`, when supplied, fires for the
   *  (large) tarball as bytes arrive. */
  downloadRelease(
    destDir: string,
    onProgress?: (p: DownloadProgress) => void,
  ): Promise<{ tarball: string; sha: string }>;
  /** Extract `tarball` into `destDir` (which already exists). */
  extract(tarball: string, destDir: string): void;
  /** `fnm install` reading the extracted tree's `.node-version`. No-op-safe
   *  when the version is already present. */
  fnmInstall(installDir: string): void;
  /** Rewrite the plist (picking up shape changes between releases) and
   *  bootstrap-or-kickstart the supervisor. Always go through this rather
   *  than a bare `kickstart` so updates that change the plist's
   *  ProgramArguments / EnvironmentVariables reach the launchd job. */
  bootstrap(installDir: string): void;
}

function defaultDownloadRelease(
  destDir: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<{ tarball: string; sha: string }> {
  return (async () => {
    const { tarball: tarballName, sha: shaName } = assetNames();
    const tarball = join(destDir, tarballName);
    const sha = join(destDir, shaName);
    // The tarball is the heavy one — stream it with progress. The .sha256 is a
    // few dozen bytes, so it downloads silently right after.
    await downloadTo(`${RELEASE_BASE}/${tarballName}`, tarball, tarballName, onProgress);
    await downloadTo(`${RELEASE_BASE}/${shaName}`, sha);
    return { tarball, sha };
  })();
}

/** Read a positive numeric `Content-Length` off a fetch Response, or null.
 *  Guarded so a stub Response without real `Headers` doesn't throw. */
function numericContentLength(res: {
  headers?: { get?(name: string): string | null };
}): number | null {
  const raw = res.headers?.get?.("content-length");
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Download `url` to `dest`. When `asset`/`onProgress` are supplied and the
 * server streams a body, bytes are piped to disk through a counting transform
 * that fires `onProgress` as they flow (real backpressure via `pipeline`, so a
 * large tarball never buffers wholly in memory). Falls back to a single
 * buffered write when there's no streamable body (e.g. a stubbed Response).
 */
async function downloadTo(
  url: string,
  dest: string,
  asset?: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`download failed (${res.status}) for ${url}`);
  }
  const total = numericContentLength(res);

  if (res.body && typeof Readable.fromWeb === "function") {
    let downloaded = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        downloaded += chunk.length;
        if (asset && onProgress) onProgress({ asset, downloaded, total });
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      counter,
      createWriteStream(dest),
    );
    // A final tick guarantees the bar lands at 100% even if the last byte-tick
    // was throttled, and supplies a total when Content-Length was absent.
    if (asset && onProgress) onProgress({ asset, downloaded, total: total ?? downloaded });
    return;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  if (asset && onProgress) onProgress({ asset, downloaded: buf.length, total: buf.length });
}

export const defaultUpdateDeps: UpdateDeps = {
  async resolveLatestVersion(): Promise<string> {
    const res = await fetch(`${RELEASE_BASE}/${VERSION_NAME}`, { redirect: "follow" });
    if (!res.ok) throw new Error(`could not resolve latest version (${res.status})`);
    // Validate at the network boundary: the fetched string becomes a path
    // segment downstream, so reject anything that isn't strict semver here.
    return assertValidVersion((await res.text()).trim());
  },
  downloadRelease: defaultDownloadRelease,
  extract(tarball: string, destDir: string): void {
    const r = spawnSync("tar", ["-xzf", tarball, "-C", destDir], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`tar extract exited ${r.status}`);
  },
  fnmInstall(installDir: string): void {
    const fnm = launchd.fnmPath();
    if (!fnm) {
      throw new Error("cannot locate fnm: `brew --prefix` failed. `brew install fnm`.");
    }
    const r = spawnSync(fnm, ["install"], { cwd: installDir, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`fnm install exited ${r.status}`);
  },
  bootstrap(installDir: string): void {
    launchd.bootstrap(installDir);
  },
};

/** sha256 of a file, hex. */
function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Read the installed version: the `version` field of the `current` tree's
 *  root `package.json`. Returns null when nothing is installed. */
export function installedVersion(): string | null {
  const link = currentLink();
  if (!existsSync(link)) return null;
  try {
    const pkgPath = join(link, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** The version each existing `versions/<v>/` dir represents, sorted by semver
 *  precedence ascending. Sorting by the dir names (which ARE semver strings)
 *  is deterministic and immune to mtime churn (re-extract / restore / rsync),
 *  unlike the previous mtime ordering — see {@link compareVersions}. */
export function installedVersions(): string[] {
  const dir = versionsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(compareVersions);
}

/** The version `current` currently points at (its symlink target's
 *  basename), or null. */
export function currentVersion(): string | null {
  const link = currentLink();
  if (!existsSync(link)) return null;
  try {
    return basename(readlinkSync(link));
  } catch {
    return null;
  }
}

/** Atomically flip `current` → `versions/<version>`. The target is stored
 *  as a relative path (`versions/<version>`) so the tree stays
 *  relocatable. */
export function flipCurrent(version: string): void {
  const link = currentLink();
  const tmp = link + ".tmp";
  if (existsSync(tmp)) rmSync(tmp, { force: true });
  // Relative target keeps the symlink valid if the whole install root moves.
  symlinkSync(join("versions", version), tmp);
  renameSync(tmp, link);
}

async function doForwardUpdate(deps: UpdateDeps, reporter: UpdateReporter): Promise<void> {
  const startedAt = Date.now();
  const installed = installedVersion();

  reporter.step("Checking for the latest release…");
  // Validate at the point of consumption — independent of which
  // resolveLatestVersion implementation supplied the string — BEFORE it
  // becomes a path segment via versionDir() / flipCurrent().
  const latest = assertValidVersion(await deps.resolveLatestVersion());

  if (installed && installed === latest) {
    reporter.success(`Friday is already up to date (${installed})`);
    return;
  }

  reporter.step(`Updating ${installed ?? "(none)"} → ${pc.bold(latest)}`);

  const target = versionDir(latest);
  if (existsSync(target)) {
    // Already extracted (interrupted prior run); just flip + restart.
    reporter.note(`version ${latest} already downloaded — reusing`);
    reporter.step("Activating new version…");
    flipCurrent(latest);
    reporter.step("Restarting Friday…");
    deps.bootstrap(currentLink());
    reporter.success(`Updated to ${latest} ${elapsedSince(startedAt)}`);
    return;
  }

  const stage = await mkdtemp(join(tmpdir(), "friday-update-"));
  try {
    reporter.step("Downloading update…");
    let tarball: string;
    let sha: string;
    try {
      ({ tarball, sha } = await deps.downloadRelease(stage, (p) => reporter.progress(p)));
    } finally {
      // Close the live bar whether the download succeeded or threw mid-stream.
      reporter.endProgress();
    }

    // Verify sha256 BEFORE any extraction into the versions dir. On
    // mismatch we throw and leave no `versions/<v>/` behind.
    reporter.step("Verifying checksum…");
    const expected = readFileSync(sha, "utf8").trim().split(/\s+/)[0];
    const actual = sha256File(tarball);
    if (expected !== actual) {
      throw new Error(`sha256 mismatch — refusing to install. expected ${expected}, got ${actual}`);
    }
    reporter.note(`checksum verified (${actual.slice(0, 12)}…)`);

    // Extract into a staging dir first; only move into versions/<v> on
    // success so a failed extract never leaves a half-written version.
    reporter.step("Extracting…");
    const extractStage = join(stage, "tree");
    mkdirSync(extractStage, { recursive: true });
    deps.extract(tarball, extractStage);

    mkdirSync(versionsDir(), { recursive: true });
    renameSync(extractStage, target);
  } catch (err) {
    // Defensive: never leave a partial versions/<v> dir on failure.
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    throw err;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }

  // Provision the pinned Node for the new tree, flip, restart.
  reporter.step("Provisioning Node runtime…");
  deps.fnmInstall(target);
  reporter.step("Activating new version…");
  flipCurrent(latest);
  reporter.step("Restarting Friday…");
  deps.bootstrap(currentLink());
  reporter.success(`Updated to ${latest} ${elapsedSince(startedAt)}`);
}

async function doCheck(deps: UpdateDeps): Promise<void> {
  const installed = installedVersion();
  const latest = assertValidVersion(await deps.resolveLatestVersion());
  console.log(pc.bold("friday update — check"));
  console.log(`  installed   ${installed ?? pc.dim("(none)")}`);
  console.log(`  available   ${latest}`);
  if (installed && installed === latest) {
    console.log(pc.green("  up to date"));
  } else {
    console.log(pc.yellow(`  update available → run ${pc.cyan("friday update")}`));
  }
}

function doRollback(deps: UpdateDeps, reporter: UpdateReporter): void {
  const current = currentVersion();
  const versions = installedVersions();
  // The prior version = the install-order neighbor immediately before the
  // one `current` points at.
  const idx = current ? versions.indexOf(current) : -1;
  const prior = idx > 0 ? versions[idx - 1] : undefined;
  if (!prior) {
    console.error(
      pc.red(
        `no prior version to roll back to (current=${current ?? "none"}, installed=[${versions.join(", ")}])`,
      ),
    );
    process.exit(1);
  }
  reporter.step(`Rolling back ${current} → ${pc.bold(prior)}`);
  // Defensive: prior comes from on-disk version-dir basenames (validated at
  // install time), but re-assert before it becomes a symlink target.
  flipCurrent(assertValidVersion(prior));
  reporter.step("Restarting Friday…");
  deps.bootstrap(currentLink());
  reporter.success(`Rolled back to ${prior}`);
}

/** Core runner, deps- and reporter-injected for tests. */
export async function runUpdate(
  args: { check?: boolean; rollback?: boolean },
  deps: UpdateDeps = defaultUpdateDeps,
  reporter: UpdateReporter = createConsoleReporter(),
): Promise<void> {
  if (args.check) {
    await doCheck(deps);
    return;
  }
  if (args.rollback) {
    doRollback(deps, reporter);
    return;
  }
  await doForwardUpdate(deps, reporter);
}

export const updateCommand = defineCommand({
  meta: {
    name: "update",
    description:
      "Update Friday to the latest release (download + verify + flip + restart). --check reports; --rollback reverts.",
  },
  args: {
    check: {
      type: "boolean",
      default: false,
      description: "Report installed vs available; change nothing",
    },
    rollback: {
      type: "boolean",
      default: false,
      description: "Flip `current` back to the prior installed version",
    },
  },
  async run({ args }) {
    try {
      await runUpdate({ check: !!args.check, rollback: !!args.rollback });
    } catch (err) {
      // Surface a clean one-line failure instead of a raw stack; the staged
      // download/extract is already cleaned up by runUpdate's own try/finally.
      console.error(pc.red(`✘ update failed: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  },
});
