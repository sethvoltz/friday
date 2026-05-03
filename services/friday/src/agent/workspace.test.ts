import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
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
  getDefaultBranch,
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

    // Verify PreToolCall hook is injected with the workspace path
    const settings = JSON.parse(
      readFileSync(join(result.path, ".claude", "settings.json"), "utf8")
    );
    expect(settings.hooks?.PreToolCall).toHaveLength(1);
    const hookCommand: string = settings.hooks.PreToolCall[0].hooks[0].command;
    expect(hookCommand).toContain("workspace-guard");
    expect(hookCommand).toContain(result.path);
  });

  it("replaces stale workspace on re-creation", () => {
    const first = createWorkspace({
      builderName: "builder-dup",
      workingDirectory: workingDir,
      repos: [{ repo: localRepoPath }],
    });
    expect(existsSync(first.path)).toBe(true);

    // Re-creating with same name replaces the stale workspace
    const second = createWorkspace({
      builderName: "builder-dup",
      workingDirectory: workingDir,
      repos: [{ repo: localRepoPath, branch: "friday/builder-dup-v2" }],
    });
    expect(existsSync(second.path)).toBe(true);
    expect(second.worktrees[0].branch).toBe("friday/builder-dup-v2");
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

describe("getDefaultBranch — bare clone refs/remotes/origin/* behavior", () => {
  const bareTestDir = join(testDir, "bare-test");
  let originRepoPath: string;
  let bareCachePath: string;

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@test.com",
  };

  beforeEach(() => {
    mkdirSync(bareTestDir, { recursive: true });
    originRepoPath = join(bareTestDir, "origin");
    bareCachePath = join(bareTestDir, "cache.git");

    // Create a non-bare "origin" repo
    mkdirSync(originRepoPath, { recursive: true });
    execSync("git init", { cwd: originRepoPath, stdio: "pipe" });
    execSync("git checkout -b main", { cwd: originRepoPath, stdio: "pipe" });
    execSync('git commit --allow-empty -m "initial"', {
      cwd: originRepoPath,
      stdio: "pipe",
      env: gitEnv,
    });

    // Bare clone — simulates what ensureBareClone does on first call
    execSync(`git clone --bare "${originRepoPath}" "${bareCachePath}"`, {
      stdio: "pipe",
    });
  });

  afterEach(() => {
    rmSync(bareTestDir, { recursive: true, force: true });
  });

  it("git clone --bare does not create refs/remotes/origin/main", () => {
    let hasRemoteRef = true;
    try {
      execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], {
        cwd: bareCachePath,
        stdio: "pipe",
      });
    } catch {
      hasRemoteRef = false;
    }
    expect(hasRemoteRef).toBe(false);
  });

  it("getDefaultBranch falls back to branch name when refs/remotes/origin/* absent", () => {
    // No fetch has run yet — refs/remotes/origin/main does not exist
    expect(getDefaultBranch(bareCachePath)).toBe("main");
  });

  it("getDefaultBranch returns origin/<branch> after fetch populates refs/remotes/origin/*", () => {
    execFileSync(
      "git",
      ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"],
      { cwd: bareCachePath, stdio: "pipe" }
    );
    expect(getDefaultBranch(bareCachePath)).toBe("origin/main");
  });

  it("fetch updates refs/remotes/origin/main to current remote HEAD after origin advances", () => {
    // Advance origin past the initial commit
    execSync('git commit --allow-empty -m "second"', {
      cwd: originRepoPath,
      stdio: "pipe",
      env: gitEnv,
    });
    const newHead = execSync("git rev-parse HEAD", {
      cwd: originRepoPath,
      stdio: "pipe",
    })
      .toString()
      .trim();

    // Run the same fetch that ensureBareClone now always executes
    execFileSync(
      "git",
      [
        "fetch",
        "origin",
        "+refs/heads/*:refs/heads/*",
        "+refs/heads/*:refs/remotes/origin/*",
      ],
      { cwd: bareCachePath, stdio: "pipe" }
    );

    const remoteMain = execFileSync(
      "git",
      ["rev-parse", "refs/remotes/origin/main"],
      { cwd: bareCachePath, stdio: "pipe" }
    )
      .toString()
      .trim();

    expect(remoteMain).toBe(newHead);
    expect(getDefaultBranch(bareCachePath)).toBe("origin/main");
  });
});
