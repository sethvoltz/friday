import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { execSync } from "node:child_process";
import { REPOS_DIR } from "@friday/shared";
import { log } from "../log.js";

export interface RepoSource {
  /** Local path to an existing git repo, or a remote URL (HTTPS/SSH/gh shorthand) */
  repo: string;
  /** Branch to check out in the worktree. Defaults to a new branch named after the builder. */
  branch?: string;
}

export interface WorkspaceCreateOptions {
  /** Builder name — used for directory naming and default branch names */
  builderName: string;
  /** Root directory for workspaces (from config workingDirectory) */
  workingDirectory: string;
  /** Repos to set up as worktrees in the workspace */
  repos: RepoSource[];
}

export interface WorkspaceInfo {
  /** Absolute path to the workspace root */
  path: string;
  /** Worktrees created within the workspace */
  worktrees: Array<{ name: string; path: string; branch: string; source: string }>;
}

/**
 * Determine if a repo string is a local path or a remote URL.
 */
function isRemoteRepo(repo: string): boolean {
  return (
    repo.startsWith("https://") ||
    repo.startsWith("git@") ||
    repo.startsWith("ssh://") ||
    repo.includes("github.com/") ||
    // gh shorthand: "org/repo"
    /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)
  );
}

/**
 * Derive a directory name from a repo URL or path.
 * "https://github.com/org/repo.git" → "repo"
 * "/Users/seth/Development/my-blog" → "my-blog"
 * "org/repo" → "repo"
 */
function repoName(repo: string): string {
  // Strip trailing .git
  const cleaned = repo.replace(/\.git$/, "");
  // Get the last path segment
  const name = basename(cleaned);
  return name || "repo";
}

/**
 * For a remote repo, derive the cache path under ~/.friday/repos/.
 * "https://github.com/org/repo.git" → "~/.friday/repos/org/repo"
 * "org/repo" → "~/.friday/repos/org/repo"
 */
function repoCachePath(repo: string): string {
  const cleaned = repo.replace(/\.git$/, "");

  // Try to extract org/repo from various URL formats
  let orgRepo: string | null = null;

  // gh shorthand: "org/repo"
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(cleaned)) {
    orgRepo = cleaned;
  }

  // HTTPS: "https://github.com/org/repo"
  const httpsMatch = cleaned.match(/github\.com\/([^/]+\/[^/]+)/);
  if (httpsMatch) {
    orgRepo = httpsMatch[1];
  }

  // SSH: "git@github.com:org/repo"
  const sshMatch = cleaned.match(/github\.com:([^/]+\/[^/]+)/);
  if (sshMatch) {
    orgRepo = sshMatch[1];
  }

  if (orgRepo) {
    return join(REPOS_DIR, ...orgRepo.split("/"));
  }

  // Fallback: use the repo name
  return join(REPOS_DIR, repoName(repo));
}

/**
 * Resolve a repo URL to a cloneable URL.
 * For gh shorthand ("org/repo"), convert to HTTPS via gh.
 * For everything else, return as-is.
 */
function resolveCloneUrl(repo: string): string {
  // gh shorthand: "org/repo" → use gh to clone (handles auth)
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
    return `https://github.com/${repo}.git`;
  }
  return repo;
}

/**
 * Ensure a bare clone exists at the cache path for a remote repo.
 * Uses `gh repo clone` for GitHub repos to leverage gh auth.
 */
function ensureBareClone(repo: string): string {
  const cachePath = repoCachePath(repo);

  if (existsSync(cachePath)) {
    // Fetch latest
    log("info", "repo_cache_fetch", { repo, cachePath });
    try {
      execSync("git fetch --all", { cwd: cachePath, stdio: "pipe" });
    } catch (err) {
      log("warn", "repo_cache_fetch_failed", {
        repo,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return cachePath;
  }

  mkdirSync(join(cachePath, ".."), { recursive: true });

  // Use gh for GitHub repos (handles auth), git clone --bare for others
  const isGhShorthand = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo);
  if (isGhShorthand || repo.includes("github.com")) {
    const target = isGhShorthand ? repo : resolveCloneUrl(repo);
    log("info", "repo_cache_clone_gh", { repo, cachePath });
    execSync(`gh repo clone ${target} "${cachePath}" -- --bare`, {
      stdio: "pipe",
    });
  } else {
    log("info", "repo_cache_clone_git", { repo, cachePath });
    execSync(`git clone --bare "${resolveCloneUrl(repo)}" "${cachePath}"`, {
      stdio: "pipe",
    });
  }

  return cachePath;
}

/**
 * Check if a local path is a git repository.
 */
function isGitRepo(localPath: string): boolean {
  try {
    execSync("git rev-parse --git-dir", {
      cwd: localPath,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Add a git worktree from a source repo into a target directory.
 */
function addWorktree(
  sourceRepo: string,
  targetDir: string,
  branch: string
): void {
  // Create a new branch based on the default branch
  const defaultBranch = getDefaultBranch(sourceRepo);
  execSync(
    `git worktree add -b "${branch}" "${targetDir}" "${defaultBranch}"`,
    { cwd: sourceRepo, stdio: "pipe" }
  );
}

/**
 * Get the default branch of a repository.
 */
function getDefaultBranch(repoPath: string): string {
  try {
    // For bare repos, check HEAD
    const head = execSync("git symbolic-ref HEAD", {
      cwd: repoPath,
      stdio: "pipe",
    })
      .toString()
      .trim();
    return head.replace("refs/heads/", "");
  } catch {
    // Fallback
    return "main";
  }
}

/**
 * Create a workspace for a builder with the specified repos.
 */
export function createWorkspace(options: WorkspaceCreateOptions): WorkspaceInfo {
  const { builderName, workingDirectory, repos } = options;
  const workspacesDir = join(workingDirectory, "workspaces");
  const workspacePath = join(workspacesDir, builderName);

  if (existsSync(workspacePath)) {
    throw new Error(
      `Workspace already exists at ${workspacePath}`
    );
  }

  mkdirSync(workspacePath, { recursive: true });

  // Inject .claude directory for workspace-level config
  const claudeDir = join(workspacePath, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify(
      {
        permissions: {
          allow: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"],
        },
      },
      null,
      2
    )
  );

  const worktrees: WorkspaceInfo["worktrees"] = [];

  for (const { repo, branch } of repos) {
    const name = repoName(repo);
    const worktreeBranch = branch ?? `friday/${builderName}`;
    const worktreePath = join(workspacePath, name);

    let sourceRepoPath: string;

    if (!isRemoteRepo(repo)) {
      // Local path — resolve and validate
      const localPath = resolve(repo);
      if (!existsSync(localPath)) {
        throw new Error(`Local path does not exist: ${localPath}`);
      }
      if (!isGitRepo(localPath)) {
        throw new Error(`Local path is not a git repository: ${localPath}`);
      }
      sourceRepoPath = localPath;
      log("info", "worktree_from_local", { repo: localPath, worktreePath });
    } else {
      // Remote — ensure bare clone in cache
      sourceRepoPath = ensureBareClone(repo);
      log("info", "worktree_from_cache", { repo, cachePath: sourceRepoPath, worktreePath });
    }

    addWorktree(sourceRepoPath, worktreePath, worktreeBranch);

    worktrees.push({
      name,
      path: worktreePath,
      branch: worktreeBranch,
      source: sourceRepoPath,
    });
  }

  log("info", "workspace_created", {
    builderName,
    path: workspacePath,
    worktreeCount: worktrees.length,
  });

  return { path: workspacePath, worktrees };
}

/**
 * Add a worktree to an existing workspace.
 */
export function addWorktreeToWorkspace(
  workspacePath: string,
  repo: RepoSource,
  builderName: string
): { name: string; path: string; branch: string; source: string } {
  if (!existsSync(workspacePath)) {
    throw new Error(`Workspace does not exist: ${workspacePath}`);
  }

  const name = repoName(repo.repo);
  const worktreeBranch = repo.branch ?? `friday/${builderName}`;
  const worktreePath = join(workspacePath, name);

  if (existsSync(worktreePath)) {
    throw new Error(`Worktree already exists at ${worktreePath}`);
  }

  let sourceRepoPath: string;

  if (!isRemoteRepo(repo.repo)) {
    const localPath = resolve(repo.repo);
    if (!existsSync(localPath) || !isGitRepo(localPath)) {
      throw new Error(`Invalid local git repository: ${localPath}`);
    }
    sourceRepoPath = localPath;
  } else {
    sourceRepoPath = ensureBareClone(repo.repo);
  }

  addWorktree(sourceRepoPath, worktreePath, worktreeBranch);

  log("info", "worktree_added", { workspacePath, name, branch: worktreeBranch });

  return { name, path: worktreePath, branch: worktreeBranch, source: sourceRepoPath };
}

/**
 * Remove a worktree from a workspace.
 */
export function removeWorktreeFromWorkspace(
  workspacePath: string,
  worktreeName: string
): void {
  const worktreePath = join(workspacePath, worktreeName);
  if (!existsSync(worktreePath)) {
    throw new Error(`Worktree does not exist: ${worktreePath}`);
  }

  // Find the source repo and remove the worktree properly
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: worktreePath,
      stdio: "pipe",
    });
  } catch {
    // If git worktree remove fails, clean up manually
    rmSync(worktreePath, { recursive: true, force: true });
  }

  log("info", "worktree_removed", { workspacePath, worktreeName });
}

/**
 * Destroy a workspace and all its worktrees.
 */
export function destroyWorkspace(workspacePath: string): void {
  if (!existsSync(workspacePath)) {
    throw new Error(`Workspace does not exist: ${workspacePath}`);
  }

  // Clean up git worktrees properly before removing the directory
  try {
    const entries = execSync("ls", { cwd: workspacePath, stdio: "pipe" })
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);

    for (const entry of entries) {
      const entryPath = join(workspacePath, entry);
      if (entry === ".claude") continue;
      try {
        execSync(`git worktree remove "${entryPath}" --force`, {
          cwd: entryPath,
          stdio: "pipe",
        });
      } catch {
        // Continue — will be cleaned up by rmSync
      }
    }
  } catch {
    // Continue with directory removal
  }

  rmSync(workspacePath, { recursive: true, force: true });
  log("info", "workspace_destroyed", { workspacePath });
}

// Exported for testing
export { isRemoteRepo, repoName, repoCachePath, isGitRepo };
