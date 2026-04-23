import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `friday-workspace-${process.pid}-${Date.now()}`);
const fridayDir = join(testDir, ".friday");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testDir };
});

vi.mock("../log.js", () => ({ log: vi.fn() }));

const {
  isRemoteRepo,
  repoName,
  repoCachePath,
  isGitRepo,
  createWorkspace,
  destroyWorkspace,
} = await import("./workspace.js");

describe("workspace utilities", () => {
  describe("isRemoteRepo", () => {
    it("identifies HTTPS URLs", () => {
      expect(isRemoteRepo("https://github.com/org/repo.git")).toBe(true);
      expect(isRemoteRepo("https://github.com/org/repo")).toBe(true);
    });

    it("identifies SSH URLs", () => {
      expect(isRemoteRepo("git@github.com:org/repo.git")).toBe(true);
    });

    it("identifies gh shorthand", () => {
      expect(isRemoteRepo("org/repo")).toBe(true);
      expect(isRemoteRepo("my-org/my-repo")).toBe(true);
    });

    it("identifies local paths", () => {
      expect(isRemoteRepo("/Users/seth/Development/blog")).toBe(false);
      expect(isRemoteRepo("./relative/path")).toBe(false);
      expect(isRemoteRepo("~/Development/blog")).toBe(false);
    });
  });

  describe("repoName", () => {
    it("extracts name from HTTPS URL", () => {
      expect(repoName("https://github.com/org/my-repo.git")).toBe("my-repo");
      expect(repoName("https://github.com/org/my-repo")).toBe("my-repo");
    });

    it("extracts name from local path", () => {
      expect(repoName("/Users/seth/Development/my-blog")).toBe("my-blog");
    });

    it("extracts name from gh shorthand", () => {
      expect(repoName("org/repo")).toBe("repo");
    });
  });

  describe("repoCachePath", () => {
    it("maps HTTPS URL to cache path", () => {
      const path = repoCachePath("https://github.com/acme/widgets.git");
      expect(path).toBe(join(fridayDir, "repos", "acme", "widgets"));
    });

    it("maps gh shorthand to cache path", () => {
      const path = repoCachePath("acme/widgets");
      expect(path).toBe(join(fridayDir, "repos", "acme", "widgets"));
    });

    it("maps SSH URL to cache path", () => {
      const path = repoCachePath("git@github.com:acme/widgets.git");
      expect(path).toBe(join(fridayDir, "repos", "acme", "widgets"));
    });
  });
});

describe("workspace lifecycle", () => {
  const workingDir = join(testDir, "working");
  let localRepoPath: string;

  beforeEach(() => {
    mkdirSync(fridayDir, { recursive: true });
    mkdirSync(workingDir, { recursive: true });

    // Create a real local git repo for testing
    localRepoPath = join(testDir, "local-repo");
    mkdirSync(localRepoPath, { recursive: true });
    execSync("git init", { cwd: localRepoPath, stdio: "pipe" });
    execSync("git checkout -b main", { cwd: localRepoPath, stdio: "pipe" });
    execSync('git commit --allow-empty -m "initial"', {
      cwd: localRepoPath,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    });
  });

  afterEach(() => {
    // Clean up worktrees before removing the directory
    try {
      execSync(`git worktree prune`, { cwd: localRepoPath, stdio: "pipe" });
    } catch {
      // ignore
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it("detects git repos", () => {
    expect(isGitRepo(localRepoPath)).toBe(true);
    expect(isGitRepo(testDir)).toBe(false);
  });

  it("creates workspace with local repo worktree", () => {
    const result = createWorkspace({
      builderName: "builder-test",
      workingDirectory: workingDir,
      repos: [{ repo: localRepoPath }],
    });

    expect(result.path).toBe(join(workingDir, "workspaces", "builder-test"));
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(join(result.path, ".claude", "settings.json"))).toBe(true);
    expect(result.worktrees).toHaveLength(1);
    expect(result.worktrees[0].branch).toBe("friday/builder-test");
    expect(existsSync(result.worktrees[0].path)).toBe(true);

    // Verify it's actually a git worktree
    expect(isGitRepo(result.worktrees[0].path)).toBe(true);
  });

  it("rejects duplicate workspace", () => {
    createWorkspace({
      builderName: "builder-dup",
      workingDirectory: workingDir,
      repos: [{ repo: localRepoPath }],
    });

    expect(() =>
      createWorkspace({
        builderName: "builder-dup",
        workingDirectory: workingDir,
        repos: [{ repo: localRepoPath }],
      })
    ).toThrow("already exists");
  });

  it("rejects non-existent local path", () => {
    expect(() =>
      createWorkspace({
        builderName: "builder-bad",
        workingDirectory: workingDir,
        repos: [{ repo: "/nonexistent/path" }],
      })
    ).toThrow("does not exist");
  });

  it("rejects local path that is not a git repo", () => {
    const notARepo = join(testDir, "not-a-repo");
    mkdirSync(notARepo, { recursive: true });

    expect(() =>
      createWorkspace({
        builderName: "builder-bad",
        workingDirectory: workingDir,
        repos: [{ repo: notARepo }],
      })
    ).toThrow("not a git repository");
  });

  it("destroys workspace", () => {
    const result = createWorkspace({
      builderName: "builder-destroy",
      workingDirectory: workingDir,
      repos: [{ repo: localRepoPath }],
    });

    destroyWorkspace(result.path);
    expect(existsSync(result.path)).toBe(false);
  });

  it("uses custom branch name", () => {
    const result = createWorkspace({
      builderName: "builder-branch",
      workingDirectory: workingDir,
      repos: [{ repo: localRepoPath, branch: "feature/custom" }],
    });

    expect(result.worktrees[0].branch).toBe("feature/custom");
  });
});
