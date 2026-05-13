/**
 * Workspace (git worktree) management for Builders.
 *
 * Convention: builders run inside `~/.friday/workspaces/<builder-name>/` —
 * a fresh git worktree off the project's main repo. The orchestrator's
 * `agent_create` tool dispatches here when type=builder.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
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

export function workspacesRoot(): string {
  return WORKSPACES_ROOT;
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
    throw new Error(
      `refusing to operate on path outside ${rootReal}: ${candidateReal}`,
    );
  }
  return candidateReal;
}

export interface CreateWorkspaceOptions {
  name: string;
  baseRepo: string;
  branch: string;
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
  const fromRef = opts.fromRef ?? "main";
  try {
    execFileSync(
      "git",
      ["worktree", "add", "-b", opts.branch, path, fromRef],
      { cwd: opts.baseRepo, stdio: "inherit" },
    );
  } catch (err) {
    logger.log("error", "workspace.create.fail", {
      name: opts.name,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  // Stamp a marker file inside the workspace so the worker can verify it.
  atomicWriteFile(
    join(path, ".friday-workspace.json"),
    JSON.stringify({
      name: opts.name,
      branch: opts.branch,
      createdAt: new Date().toISOString(),
    }),
  );
  return { path, branch: opts.branch, baseRepo: opts.baseRepo };
}

export function destroyWorkspace(name: string, baseRepo: string): void {
  const path = workspacePath(name);
  if (!existsSync(path)) return;
  // FIX_FORWARD 6.4: containment check before any rm-equivalent op.
  // Resolves symlinks so we never delete outside ~/.friday/workspaces/.
  assertInsideWorkspacesRoot(path);
  try {
    execFileSync("git", ["worktree", "remove", "--force", path], {
      cwd: baseRepo,
      stdio: "inherit",
    });
  } catch (err) {
    logger.log("warn", "workspace.destroy.fail", {
      name,
      message: err instanceof Error ? err.message : String(err),
    });
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
}
