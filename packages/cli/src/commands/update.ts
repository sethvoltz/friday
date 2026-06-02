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
 * Asset names (darwin-arm64 v1): `friday-darwin-arm64.tar.gz` +
 * `.tar.gz.sha256` + `VERSION`. Resolution is via GitHub's release-asset
 * redirect (`releases/latest/download/<asset>`) — no auth, no JSON parsing.
 *
 * The network + filesystem-extract + launchctl steps are injected via the
 * `UpdateDeps` seam so unit tests exercise the flip/rollback/verify logic
 * against scratch tmp dirs without hitting the network or real launchctl.
 */

import { defineCommand } from "citty";
import pc from "picocolors";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import * as launchd from "../lib/launchd.js";
import { currentLink, versionDir, versionsDir } from "../lib/install-paths.js";

const RELEASE_BASE = "https://github.com/sethvoltz/friday/releases/latest/download";
const TARBALL_NAME = "friday-darwin-arm64.tar.gz";
const SHA_NAME = "friday-darwin-arm64.tar.gz.sha256";
const VERSION_NAME = "VERSION";

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
 * Injectable side-effect surface. The default implementation hits the real
 * network / filesystem / launchctl; tests pass stubs.
 */
export interface UpdateDeps {
  /** Fetch the latest published version string (the `VERSION` asset). */
  resolveLatestVersion(): Promise<string>;
  /** Download the tarball + its `.sha256` into `destDir`. Returns the
   *  absolute paths of each. */
  downloadRelease(destDir: string): Promise<{ tarball: string; sha: string }>;
  /** Extract `tarball` into `destDir` (which already exists). */
  extract(tarball: string, destDir: string): void;
  /** `fnm install` reading the extracted tree's `.node-version`. No-op-safe
   *  when the version is already present. */
  fnmInstall(installDir: string): void;
  /** `launchctl kickstart -k` the supervisor. */
  kickstart(): void;
}

function defaultDownloadRelease(destDir: string): Promise<{ tarball: string; sha: string }> {
  return (async () => {
    const tarball = join(destDir, TARBALL_NAME);
    const sha = join(destDir, SHA_NAME);
    await downloadTo(`${RELEASE_BASE}/${TARBALL_NAME}`, tarball);
    await downloadTo(`${RELEASE_BASE}/${SHA_NAME}`, sha);
    return { tarball, sha };
  })();
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`download failed (${res.status}) for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
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
  kickstart(): void {
    launchd.kickstart();
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

async function doForwardUpdate(deps: UpdateDeps): Promise<void> {
  const installed = installedVersion();
  // Validate at the point of consumption — independent of which
  // resolveLatestVersion implementation supplied the string — BEFORE it
  // becomes a path segment via versionDir() / flipCurrent().
  const latest = assertValidVersion(await deps.resolveLatestVersion());

  if (installed && installed === latest) {
    console.log(pc.green(`friday is up to date (${installed})`));
    return;
  }

  console.log(pc.bold(`updating friday ${installed ?? "(none)"} → ${latest}`));

  const target = versionDir(latest);
  if (existsSync(target)) {
    // Already extracted (interrupted prior run); just flip + restart.
    console.log(pc.dim(`  version ${latest} already extracted — flipping`));
    flipCurrent(latest);
    deps.kickstart();
    console.log(pc.green(`✓ updated to ${latest}`));
    return;
  }

  const stage = await mkdtemp(join(tmpdir(), "friday-update-"));
  try {
    const { tarball, sha } = await deps.downloadRelease(stage);

    // Verify sha256 BEFORE any extraction into the versions dir. On
    // mismatch we throw and leave no `versions/<v>/` behind.
    const expected = readFileSync(sha, "utf8").trim().split(/\s+/)[0];
    const actual = sha256File(tarball);
    if (expected !== actual) {
      throw new Error(`sha256 mismatch — refusing to install. expected ${expected}, got ${actual}`);
    }
    console.log(pc.dim(`  sha256 verified (${actual.slice(0, 12)}…)`));

    // Extract into a staging dir first; only move into versions/<v> on
    // success so a failed extract never leaves a half-written version.
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
  deps.fnmInstall(target);
  flipCurrent(latest);
  deps.kickstart();
  console.log(pc.green(`✓ updated to ${latest}`));
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

function doRollback(deps: UpdateDeps): void {
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
  console.log(pc.bold(`rolling back ${current} → ${prior}`));
  // Defensive: prior comes from on-disk version-dir basenames (validated at
  // install time), but re-assert before it becomes a symlink target.
  flipCurrent(assertValidVersion(prior));
  deps.kickstart();
  console.log(pc.green(`✓ rolled back to ${prior}`));
}

/** Core runner, deps-injected for tests. */
export async function runUpdate(
  args: { check?: boolean; rollback?: boolean },
  deps: UpdateDeps = defaultUpdateDeps,
): Promise<void> {
  if (args.check) {
    await doCheck(deps);
    return;
  }
  if (args.rollback) {
    doRollback(deps);
    return;
  }
  await doForwardUpdate(deps);
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
    await runUpdate({ check: !!args.check, rollback: !!args.rollback });
  },
});
