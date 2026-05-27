/**
 * PF-2: archiveWorkspace also force-deletes the branch in the parent repo.
 *
 * Semantic: archiving an agent means it stops receiving work and (for
 * builders) its disk resources are freed. Sessions persist as history.
 * Leaving the friday/<name> branch behind accumulates dead refs and breaks
 * re-creating a Builder of the same name (`git worktree add -b <branch>`
 * fails on an existing branch).
 *
 * Drives real git via execFileSync against a tempdir-rooted repo.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// macOS resolves /var/folders/... → /private/var/folders/..., and `git
// worktree list` reports the realpath'd path. Realpath the dataRoot up
// front so workspacePath() matches what git emits.
const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "friday-ws-archive-")));
process.env.FRIDAY_DATA_DIR = dataRoot;

// Fresh module load so WORKSPACES_ROOT picks up our FRIDAY_DATA_DIR.
const { createWorkspace, archiveWorkspace, workspacePath } = await import("./workspace.js");

const baseRepo = realpathSync(mkdtempSync(join(tmpdir(), "friday-ws-archive-repo-")));

function git(args: string[], cwd = baseRepo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function listBranches(): string[] {
  return git(["branch", "--list", "--format=%(refname:short)"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function listWorktrees(): string[] {
  return git(["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
}

beforeAll(() => {
  // Initialize a minimal repo with an initial commit so worktree-add works.
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(baseRepo, "README.md"), "# test\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "init"]);
  // Add a self-referencing remote so `origin/main` exists — createWorkspace
  // now fetches origin/main by default and uses it as the start-point.
  git(["remote", "add", "origin", baseRepo]);
  git(["fetch", "-q", "origin"]);
});

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(baseRepo, { recursive: true, force: true });
});

describe("archiveWorkspace + branch deletion", () => {
  it("deletes both the worktree and the branch when branch is passed", () => {
    const name = "alpha";
    const branch = "friday/alpha";
    createWorkspace({ name, baseRepo, branch });

    // Sanity: branch exists; worktree is listed.
    expect(listBranches()).toContain(branch);
    expect(listWorktrees()).toContain(workspacePath(name));

    archiveWorkspace(name, baseRepo, { branch });

    expect(listWorktrees()).not.toContain(workspacePath(name));
    expect(listBranches()).not.toContain(branch);
  });

  it("force-deletes an unmerged branch (work was thrown away on purpose)", () => {
    const name = "beta";
    const branch = "friday/beta";
    createWorkspace({ name, baseRepo, branch });

    // Add an unmerged commit to the worktree so a non-force branch delete
    // would fail. archiveWorkspace must still succeed (uses `branch -D`).
    const wt = workspacePath(name);
    writeFileSync(join(wt, "scratch.txt"), "wip\n");
    execFileSync("git", ["add", "scratch.txt"], { cwd: wt });
    execFileSync("git", ["commit", "-q", "-m", "wip"], { cwd: wt });

    archiveWorkspace(name, baseRepo, { branch });

    expect(listBranches()).not.toContain(branch);
  });

  it("does not delete the branch when called without the branch option (legacy)", () => {
    const name = "gamma";
    const branch = "friday/gamma";
    createWorkspace({ name, baseRepo, branch });
    expect(listBranches()).toContain(branch);

    archiveWorkspace(name, baseRepo);

    expect(listWorktrees()).not.toContain(workspacePath(name));
    // Branch left in place for callers that haven't migrated to passing it.
    expect(listBranches()).toContain(branch);

    // Clean up manually so the next test isn't polluted.
    execFileSync("git", ["branch", "-D", branch], { cwd: baseRepo });
  });

  it("tolerates a branch that's already been deleted manually", () => {
    const name = "delta";
    const branch = "friday/delta";
    createWorkspace({ name, baseRepo, branch });

    // Skip the worktree dir cleanup so we exercise the branch-delete branch
    // even when the worktree path has already been wiped.
    execFileSync("git", ["worktree", "remove", "--force", workspacePath(name)], {
      cwd: baseRepo,
    });
    execFileSync("git", ["branch", "-D", branch], { cwd: baseRepo });

    // archiveWorkspace should not throw even though both pieces are already gone.
    expect(() => archiveWorkspace(name, baseRepo, { branch })).not.toThrow();
    expect(listBranches()).not.toContain(branch);
  });

  it("archives the worktree even when only the directory is left over", () => {
    // Pre-create a stray directory under workspaces root without a real
    // worktree backing it (simulating a partially-failed prior run).
    const name = "epsilon";
    mkdirSync(workspacePath(name), { recursive: true });
    writeFileSync(join(workspacePath(name), "stray.txt"), "x");

    // archiveWorkspace removes the directory even without a branch arg.
    expect(() => archiveWorkspace(name, baseRepo)).not.toThrow();
  });

  it("pre-flight: succeeds when branch already exists locally from a prior failed cleanup", () => {
    // Simulate a stale local branch left by a prior failed createWorkspace run:
    // the branch exists locally but has no associated worktree directory.
    const name = "zeta";
    const branch = "friday/zeta";

    // Create the branch locally without a worktree so it's orphaned.
    git(["branch", branch]);
    expect(listBranches()).toContain(branch);

    // createWorkspace must delete the stale branch and succeed.
    expect(() => createWorkspace({ name, baseRepo, branch })).not.toThrow();
    expect(listBranches()).toContain(branch);
    expect(listWorktrees()).toContain(workspacePath(name));

    // Clean up.
    archiveWorkspace(name, baseRepo, { branch });
  });

  it("createWorkspace uses origin/main as the start-point by default", () => {
    // origin/main should exist (set up in beforeAll via self-referencing remote).
    // Create a workspace without fromRef — it should root off origin/main.
    const name = "eta";
    const branch = "friday/eta";
    expect(() => createWorkspace({ name, baseRepo, branch })).not.toThrow();
    expect(listWorktrees()).toContain(workspacePath(name));
    archiveWorkspace(name, baseRepo, { branch });
  });

  it("createWorkspace uses caller-supplied fromRef for stacked PR (skips origin/main)", () => {
    // With fromRef set explicitly, the workspace should root off that ref.
    const name = "theta";
    const branch = "friday/theta";
    expect(() => createWorkspace({ name, baseRepo, branch, fromRef: "main" })).not.toThrow();
    expect(listWorktrees()).toContain(workspacePath(name));
    archiveWorkspace(name, baseRepo, { branch });
  });
});
