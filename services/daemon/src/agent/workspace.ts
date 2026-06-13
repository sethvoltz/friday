/**
 * Workspace (git worktree) management for Builders.
 *
 * Convention: builders run inside `~/.friday/workspaces/<builder-name>/` —
 * a fresh git worktree off the project's main repo. The orchestrator's
 * `agent_create` tool dispatches here when type=builder.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { DATA_DIR, atomicWriteFile } from "@friday/shared";
import { logger } from "../log.js";

/**
 * Resolve `candidate` through realpath. If the leaf doesn't exist (e.g. a
 * workspace that was already removed), walk up to the nearest existing
 * parent and re-attach the missing tail — that way symlink-following on
 * the parent still gives us the canonical absolute path (notably
 * `/private/var/...` vs `/var/...` on macOS).
 */
function realpathWithMissingTail(candidate: string): string {
  let cur = normalize(candidate).replace(/\/+$/, "");
  let tail = "";
  for (let i = 0; i < 256; i++) {
    try {
      const real = realpathSync(cur);
      return tail ? join(real, tail) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return tail ? join(cur, tail) : cur;
      const leaf = basename(cur);
      tail = tail ? join(leaf, tail) : leaf;
      cur = parent;
    }
  }
  return tail ? join(cur, tail) : cur;
}

const WORKSPACES_ROOT = join(DATA_DIR, "workspaces");

/**
 * Bare-mirror clones live here. When a builder's `baseRepo` is a remote URL
 * rather than a local checkout, we maintain one `--mirror` clone per repo at
 * `<DATA_DIR>/repos/<name>.git` and worktree the builder's workspace off it.
 * This removes the need for a persistent local dev tree on the machine.
 */
const REPOS_ROOT = join(DATA_DIR, "repos");

export function workspacesRoot(): string {
  return WORKSPACES_ROOT;
}

export function reposRoot(): string {
  return REPOS_ROOT;
}

/** Marker file dropped inside every workspace so the worker can verify it and
 * the archive path can recover the git dir the workspace was created from. */
const WORKSPACE_MARKER = ".friday-workspace.json";

interface WorkspaceMarker {
  name: string;
  branch: string;
  createdAt: string;
  /** Absolute path to the git dir the worktree is registered with: the local
   * `baseRepo` for the local path, or the bare mirror for the remote path.
   * Older markers (pre-mirror) omit this — archive falls back to `baseRepo`. */
  gitDir?: string;
}

/**
 * Decide whether `baseRepo` is a usable local git checkout. The orchestrator
 * may pass either:
 *   - a local filesystem path to an existing git working tree, OR
 *   - a remote URL (https / ssh / scp-style / file://) when there is no
 *     local checkout on the machine.
 *
 * A bare URL is the contract for the remote case — the `name` is derived from
 * the URL basename minus `.git`. The orchestrator owns the name→URL mapping;
 * the daemon only needs to accept the resolved URL here.
 */
export function isLocalRepo(baseRepo: string): boolean {
  // A `.git` entry (dir or file for worktrees/submodules) is the cheap, robust
  // signal. Remote URLs (`https://…`, `git@…:…`, `ssh://…`) never satisfy this.
  if (existsSync(join(baseRepo, ".git"))) return true;
  // Unusual layouts: fall back to asking git. Note a BARE repo answers
  // `false` here (exit 0) — that's intentional: a bare repo has no working
  // tree to `git worktree add` an in-tree builder from, so we treat it as
  // remote and mirror it. Git throws (non-zero exit) when the dir isn't a repo
  // at all, which also lands us on the remote path.
  try {
    const out = execFileSync("git", ["-C", baseRepo, "rev-parse", "--is-inside-work-tree"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** Derive a stable mirror name from a remote URL: the final path segment with
 * any trailing `.git` and slashes stripped (e.g. `git@github.com:org/agent-friday.git`
 * → `agent-friday`). */
export function mirrorNameFromRemote(remote: string): string {
  const stripped = remote.replace(/\/+$/, "").replace(/\.git$/, "");
  // Handle both `/`-separated URLs and scp-style `host:org/repo`.
  const lastSlash = stripped.lastIndexOf("/");
  const lastColon = stripped.lastIndexOf(":");
  const cut = Math.max(lastSlash, lastColon);
  const base = cut >= 0 ? stripped.slice(cut + 1) : stripped;
  return base || "repo";
}

export function mirrorPathForRemote(remote: string): string {
  return join(REPOS_ROOT, `${mirrorNameFromRemote(remote)}.git`);
}

/**
 * Ensure a bare `--mirror` clone of `remote` exists at `mirrorPath` and is
 * up to date. Returns nothing; throws on a hard clone failure (workspace
 * creation cannot proceed without it). A stale-fetch failure is non-fatal —
 * we warn and proceed against the cached mirror, mirroring the local
 * `workspace.fetch.fail` semantics.
 */
function ensureMirror(remote: string, mirrorPath: string, name: string): void {
  if (!existsSync(REPOS_ROOT)) {
    mkdirSync(REPOS_ROOT, { recursive: true });
  }
  if (!existsSync(mirrorPath)) {
    logger.log("info", "workspace.mirror.clone", { name, remote, mirrorPath });
    try {
      execFileSync("git", ["clone", "--mirror", remote, mirrorPath], { stdio: "pipe" });
    } catch (err) {
      const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
      logger.log("error", "workspace.mirror.clone.fail", {
        name,
        remote,
        mirrorPath,
        message: e.message ?? String(err),
        stderr: e.stderr ? String(e.stderr).trim() : undefined,
        stdout: e.stdout ? String(e.stdout).trim() : undefined,
      });
      throw err;
    }
    return;
  }
  // Mirror already present: refresh it so the new worktree roots on the latest
  // upstream. `remote update --prune` updates all configured remotes (a
  // --mirror clone has exactly one: `origin`) and prunes deleted refs.
  logger.log("info", "workspace.mirror.fetch", { name, mirrorPath });
  try {
    execFileSync("git", ["-C", mirrorPath, "remote", "update", "--prune"], { stdio: "pipe" });
  } catch (err) {
    const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
    logger.log("warn", "workspace.mirror.fetch.fail", {
      name,
      mirrorPath,
      message: e.message ?? String(err),
      stderr: e.stderr ? String(e.stderr).trim() : undefined,
      stdout: e.stdout ? String(e.stdout).trim() : undefined,
    });
  }
}

/**
 * FIX_FORWARD 6.4: defense-in-depth containment guard. Resolves both the
 * workspaces root and the candidate path through `realpathSync` so a
 * symlink pointing at `/etc` can't trick a deletion into nuking system
 * files. Returns the canonical absolute path on success; throws otherwise.
 *
 * `existsRequired` lets callers (delete flow) reject "no such workspace"
 * with a clear error before any destructive op runs. When false (used by
 * tests), only the parent root must exist.
 */
export function assertInsideWorkspacesRoot(
  candidate: string,
  { existsRequired = true }: { existsRequired?: boolean } = {},
): string {
  if (existsRequired && !existsSync(candidate)) {
    throw new Error(`workspace path not found: ${candidate}`);
  }
  // realpath both sides (or walk up to the nearest existing parent) so a
  // symlink can't dodge the containment check, and so macOS's /var ↔
  // /private/var indirection doesn't false-positive a "path outside" error.
  const rootReal = realpathSync(WORKSPACES_ROOT).replace(/\/+$/, "");
  const candidateReal = realpathWithMissingTail(candidate);
  if (candidateReal === rootReal) {
    throw new Error(`refusing to delete workspaces root itself: ${rootReal}`);
  }
  if (!candidateReal.startsWith(rootReal + "/")) {
    throw new Error(`refusing to operate on path outside ${rootReal}: ${candidateReal}`);
  }
  return candidateReal;
}

export interface CreateWorkspaceOptions {
  name: string;
  baseRepo: string;
  branch: string;
  /**
   * Explicit base ref for "stacked PR" workflows. When provided, the
   * worktree is rooted here and the origin/main fetch is skipped.
   * When omitted (the default), `git fetch origin main` runs first and
   * `origin/main` is used as the start-point so the new branch is always
   * rooted on the latest upstream commit.
   */
  fromRef?: string;
}

export interface Workspace {
  path: string;
  branch: string;
  baseRepo: string;
}

export function ensureWorkspacesRoot(): void {
  if (!existsSync(WORKSPACES_ROOT)) {
    mkdirSync(WORKSPACES_ROOT, { recursive: true });
  }
}

export function workspacePath(name: string): string {
  return join(WORKSPACES_ROOT, name);
}

export function createWorkspace(opts: CreateWorkspaceOptions): Workspace {
  ensureWorkspacesRoot();
  const path = workspacePath(opts.name);
  if (existsSync(path)) {
    throw new Error(`workspace ${opts.name} already exists at ${path}`);
  }

  // Two modes, decided by `baseRepo`:
  //   - LOCAL: `baseRepo` is an existing git working tree on disk →
  //     `git worktree add` directly off it (the original behavior).
  //   - REMOTE: `baseRepo` is a remote URL (no local checkout exists) →
  //     maintain a bare `--mirror` at `<DATA_DIR>/repos/<name>.git` and
  //     `git worktree add` off that mirror. The orchestrator resolves a repo
  //     NAME to this URL before calling us (out of scope here): `worktree.repo`
  //     simply arrives as a bare remote URL in that case.
  const local = isLocalRepo(opts.baseRepo);
  // `gitDir` is the cwd we run every git op against (fetch/refresh, branch
  // delete, worktree add) and the value we persist for archive.
  const gitDir = local ? opts.baseRepo : mirrorPathForRemote(opts.baseRepo);

  // Stacked PR exception: if caller supplied an explicit base ref, use it
  // as-is and skip the upstream refresh. Otherwise refresh `main` first so the
  // new branch is always rooted on the latest upstream commit, not whatever
  // the cached ref currently points at.
  //
  // The default start-point differs by mode. A `--mirror` clone maps remote
  // heads directly into `refs/heads/*` (no `refs/remotes/origin/*`), so its
  // upstream main is the local ref `main`. The local-checkout path keeps using
  // `origin/main` (a normal remote-tracking ref there).
  const refreshUpstream = opts.fromRef === undefined;
  const startPoint = opts.fromRef ?? (local ? "origin/main" : "main");

  if (local) {
    if (refreshUpstream) {
      try {
        execFileSync("git", ["fetch", "origin", "main"], {
          cwd: gitDir,
          stdio: "pipe",
        });
      } catch (err) {
        // Non-fatal: proceed with the cached origin/main. Warn so it's visible
        // in the logs, but don't abort workspace creation.
        const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
        logger.log("warn", "workspace.fetch.fail", {
          name: opts.name,
          message: e.message ?? String(err),
          stderr: e.stderr ? String(e.stderr).trim() : undefined,
          stdout: e.stdout ? String(e.stdout).trim() : undefined,
        });
      }
    }
  } else {
    // Remote: clone-or-refresh the bare mirror before worktree-ing off it.
    // A clone failure is fatal (handled inside ensureMirror via throw); a
    // refresh failure is non-fatal and proceeds against the cached mirror.
    ensureMirror(opts.baseRepo, gitDir, opts.name);
  }

  // Pre-flight: if the branch already exists (stale from a prior failed
  // cleanup), delete it before git worktree add, which would otherwise fail
  // with "branch already exists".
  try {
    execFileSync("git", ["branch", "-D", opts.branch], {
      cwd: gitDir,
      stdio: "pipe",
    });
    logger.log("info", "workspace.branch.stale-delete", {
      name: opts.name,
      branch: opts.branch,
    });
  } catch {
    // Branch didn't exist — the expected path.
  }

  try {
    execFileSync("git", ["worktree", "add", "-b", opts.branch, path, startPoint], {
      cwd: gitDir,
      stdio: "pipe",
    });
  } catch (err) {
    const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
    logger.log("error", "workspace.create.fail", {
      name: opts.name,
      message: e.message ?? String(err),
      stderr: e.stderr ? String(e.stderr).trim() : undefined,
      stdout: e.stdout ? String(e.stdout).trim() : undefined,
    });
    throw err;
  }
  // Stamp a marker file inside the workspace so the worker can verify it and
  // so archiveWorkspace can recover the git dir this worktree is registered
  // with (the mirror, for the remote path — the local checkout no longer
  // exists in that mode).
  atomicWriteFile(
    join(path, WORKSPACE_MARKER),
    JSON.stringify({
      name: opts.name,
      branch: opts.branch,
      createdAt: new Date().toISOString(),
      gitDir,
    } satisfies WorkspaceMarker),
  );
  return { path, branch: opts.branch, baseRepo: gitDir };
}

export interface ArchiveWorkspaceOptions {
  /** Branch to delete from the parent repo after the worktree is removed.
   * Optional for backward compat — older callers without branch metadata
   * skip the branch delete. New code should always pass it. */
  branch?: string;
}

/**
 * Recognize stderr from `git worktree remove` / `git branch -D` that indicates
 * the target was already gone — a fully anticipated race because the Claude
 * Agent SDK auto-removes worktrees + branches when a builder makes no file
 * changes, before Friday's own archive cleanup runs.
 *
 * Locale matters: git localizes these messages, so callers must force
 * `LC_ALL=C` on the subprocess for substring matching to be stable. Any
 * unrecognized stderr (or empty / missing stderr) returns null so the caller
 * stays on the warn path and a genuine failure isn't masked.
 */
export function classifyGitArchiveStderr(
  stderr: string | undefined | null,
): "worktree-gone" | "branch-gone" | null {
  if (!stderr) return null;
  if (stderr.includes("is not a working tree")) return "worktree-gone";
  if (stderr.includes("not found")) return "branch-gone";
  return null;
}

const C_LOCALE_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

/**
 * Recover the git dir a workspace was created from by reading its marker. For
 * mirror-based workspaces (remote mode) this is the bare mirror under
 * `<DATA_DIR>/repos/` — the local checkout that `baseRepo` would point at does
 * not exist. Returns `undefined` when there is no usable marker (older
 * pre-mirror workspaces, or the dir is already gone), so the caller falls back
 * to the `baseRepo` it was handed. Must be read BEFORE the worktree is removed.
 */
function readWorkspaceGitDir(workspaceDir: string): string | undefined {
  const markerPath = join(workspaceDir, WORKSPACE_MARKER);
  if (!existsSync(markerPath)) return undefined;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<WorkspaceMarker>;
    return typeof marker.gitDir === "string" && marker.gitDir.length > 0
      ? marker.gitDir
      : undefined;
  } catch {
    return undefined;
  }
}

export function archiveWorkspace(
  name: string,
  baseRepo: string,
  opts: ArchiveWorkspaceOptions = {},
): void {
  const path = workspacePath(name);
  // Resolve the git dir to operate against. For a mirror-based workspace the
  // worktree is registered with the bare mirror, not the (possibly missing)
  // local `baseRepo`; the marker records which. Read it before any removal,
  // since the marker lives inside the workspace dir. Falls back to `baseRepo`
  // for the local-worktree path and for older pre-mirror workspaces.
  const gitDir = readWorkspaceGitDir(path) ?? baseRepo;
  // The worktree directory might already be gone (manual cleanup, prior
  // failed run); the branch may still exist independently, so we don't
  // early-return when the dir is missing.
  if (existsSync(path)) {
    // FIX_FORWARD 6.4: containment check before any rm-equivalent op.
    // Resolves symlinks so we never delete outside ~/.friday/workspaces/.
    assertInsideWorkspacesRoot(path);
    try {
      execFileSync("git", ["worktree", "remove", "--force", path], {
        cwd: gitDir,
        stdio: "pipe",
        env: C_LOCALE_ENV,
      });
    } catch (err) {
      const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
      const stderr = e.stderr ? String(e.stderr).trim() : undefined;
      const race = classifyGitArchiveStderr(stderr);
      if (race === "worktree-gone") {
        logger.log("debug", "workspace.destroy.skip", {
          name,
          reason: race,
          stderr,
        });
      } else {
        logger.log("warn", "workspace.destroy.fail", {
          name,
          message: e.message ?? String(err),
          stderr,
          stdout: e.stdout ? String(e.stdout).trim() : undefined,
        });
      }
    }
    // The worktree-remove leaves the parent directory in place if anything
    // non-tracked accumulated there (logs, build artifacts). Wipe whatever
    // remains so the next `agent_create` with the same name can succeed.
    if (existsSync(path)) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (err) {
        logger.log("warn", "workspace.rmdir.fail", {
          name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    // Directory is already gone (manual cleanup, partial prior run). The git
    // worktree registration may still be present, which prevents branch
    // deletion. Prune removes all stale entries whose directories no longer
    // exist.
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: gitDir,
        stdio: "pipe",
      });
    } catch (err) {
      logger.log("warn", "workspace.prune.fail", {
        name,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Delete the branch from the git dir (local checkout or bare mirror).
  // "Destroy means destroy" — by the
  // time the user (or orchestrator) destroys a workspace the work has either
  // been merged via PR or been explicitly thrown away. Leaving the branch
  // behind accumulates dead refs, and re-creating a builder of the same
  // name would fail at `git worktree add -b <branch>`.
  //
  // `branch -D` is force-delete; works even on unmerged branches. We tolerate
  // failure (branch already gone, never existed, etc.) — that's not a
  // destroy-blocker.
  if (opts.branch) {
    try {
      execFileSync("git", ["branch", "-D", opts.branch], {
        cwd: gitDir,
        stdio: "pipe",
        env: C_LOCALE_ENV,
      });
    } catch (err) {
      const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
      const stderr = e.stderr ? String(e.stderr).trim() : undefined;
      const race = classifyGitArchiveStderr(stderr);
      if (race === "branch-gone") {
        logger.log("debug", "workspace.branch.delete.skip", {
          name,
          branch: opts.branch,
          reason: race,
          stderr,
        });
      } else {
        logger.log("warn", "workspace.branch.delete.fail", {
          name,
          branch: opts.branch,
          message: e.message ?? String(err),
          stderr,
        });
      }
    }
  }
}
