/**
 * Workspace (git worktree) management for Builders.
 *
 * Convention: builders run inside `~/.friday/workspaces/<builder-name>/` —
 * a fresh git worktree off the project's main repo. The orchestrator's
 * `agent_create` tool dispatches here when type=builder.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, atomicWriteFile } from "@friday/shared";
import { logger } from "../log.js";

const WORKSPACES_ROOT = join(DATA_DIR, "workspaces");

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
    // Fall back to manual rm.
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
