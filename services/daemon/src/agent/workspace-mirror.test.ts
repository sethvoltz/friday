/**
 * Bare-mirror workspace mode (no local checkout).
 *
 * When a builder's `baseRepo` is a REMOTE (a URL / a non-working-tree) rather
 * than a local checkout, createWorkspace maintains a bare `--mirror` clone at
 * `<DATA_DIR>/repos/<name>.git` and worktrees the builder off that mirror.
 * This removes the need for a persistent local dev tree on the machine.
 *
 * The hermetic "remote" here is a `git init --bare` repo with one seed commit,
 * exercised through the real git binary — a bare repo is not a working tree,
 * so isLocalRepo() classifies it as remote, taking the mirror path.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "friday-ws-mirror-")));
process.env.FRIDAY_DATA_DIR = dataRoot;

const {
  createWorkspace,
  archiveWorkspace,
  workspacePath,
  reposRoot,
  isLocalRepo,
  mirrorNameFromRemote,
  mirrorPathForRemote,
} = await import("./workspace.js");

// The "remote": a bare repo seeded via a throwaway working clone. Named with a
// `.git` suffix so the derived mirror name strips it (→ `remote-origin`).
const remoteDir = realpathSync(mkdtempSync(join(tmpdir(), "friday-ws-mirror-remote-")));
const remote = join(remoteDir, "remote-origin.git");

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function listWorktrees(gitDir: string): string[] {
  return gitIn(gitDir, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
}

function listBranches(gitDir: string): string[] {
  return gitIn(gitDir, ["branch", "--list", "--format=%(refname:short)"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

beforeAll(() => {
  // Seed the bare remote with a commit on `main` via a transient working clone.
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
  const seed = join(remoteDir, "seed");
  execFileSync("git", ["clone", "-q", remote, seed]);
  gitIn(seed, ["config", "user.email", "test@example.com"]);
  gitIn(seed, ["config", "user.name", "Test"]);
  writeFileSync(join(seed, "README.md"), "# remote\n");
  gitIn(seed, ["add", "README.md"]);
  gitIn(seed, ["commit", "-q", "-m", "seed"]);
  gitIn(seed, ["push", "-q", "origin", "main"]);
});

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(remoteDir, { recursive: true, force: true });
});

describe("remote classification helpers", () => {
  it("classifies a bare repo / non-working-tree as NOT local", () => {
    expect(isLocalRepo(remote)).toBe(false);
    expect(isLocalRepo("https://github.com/org/agent-friday.git")).toBe(false);
    expect(isLocalRepo("git@github.com:org/agent-friday.git")).toBe(false);
  });

  it("classifies an existing working tree as local", () => {
    // The transient seed clone is a real working tree.
    expect(isLocalRepo(join(remoteDir, "seed"))).toBe(true);
  });

  it("derives the mirror name from a remote URL basename minus .git", () => {
    expect(mirrorNameFromRemote("https://github.com/org/agent-friday.git")).toBe("agent-friday");
    expect(mirrorNameFromRemote("git@github.com:org/agent-friday.git")).toBe("agent-friday");
    expect(mirrorNameFromRemote("https://github.com/org/agent-friday")).toBe("agent-friday");
    expect(mirrorNameFromRemote("/some/path/repo.git/")).toBe("repo");
  });

  it("resolves the mirror path under <DATA_DIR>/repos/<name>.git", () => {
    expect(mirrorPathForRemote("https://github.com/org/agent-friday.git")).toBe(
      join(reposRoot(), "agent-friday.git"),
    );
  });
});

describe("createWorkspace (remote mirror mode)", () => {
  it("clones a bare mirror and worktrees the builder off it", () => {
    const name = "mirror-alpha";
    const branch = "friday/mirror-alpha";
    const mirrorPath = mirrorPathForRemote(remote);

    expect(existsSync(mirrorPath)).toBe(false);

    const ws = createWorkspace({ name, baseRepo: remote, branch });

    // Mirror was created under <DATA_DIR>/repos/.
    expect(mirrorPath).toBe(join(reposRoot(), "remote-origin.git"));
    expect(existsSync(mirrorPath)).toBe(true);
    // Worktree exists and is registered with the MIRROR, not the remote.
    expect(existsSync(ws.path)).toBe(true);
    expect(listWorktrees(mirrorPath)).toContain(ws.path);
    expect(listBranches(mirrorPath)).toContain(branch);
    // ws.baseRepo is the mirror, and the marker records the mirror as gitDir.
    expect(ws.baseRepo).toBe(mirrorPath);
    const marker = JSON.parse(readFileSync(join(ws.path, ".friday-workspace.json"), "utf8"));
    expect(marker.gitDir).toBe(mirrorPath);

    archiveWorkspace(name, remote, { branch });
  });

  it("refreshes (not re-clones) an existing mirror on a second create", () => {
    const mirrorPath = mirrorPathForRemote(remote);
    // Mirror from the previous test persists across creates.
    expect(existsSync(mirrorPath)).toBe(true);

    const name = "mirror-beta";
    const branch = "friday/mirror-beta";
    expect(() => createWorkspace({ name, baseRepo: remote, branch })).not.toThrow();
    expect(listWorktrees(mirrorPath)).toContain(workspacePath(name));
    archiveWorkspace(name, remote, { branch });
  });
});

describe("archiveWorkspace (remote mirror mode)", () => {
  it("removes the worktree + branch using the mirror recorded in the marker", () => {
    const name = "mirror-gamma";
    const branch = "friday/mirror-gamma";
    const mirrorPath = mirrorPathForRemote(remote);

    const ws = createWorkspace({ name, baseRepo: remote, branch });
    // dataRoot is already realpath'd, so ws.path is canonical and matches the
    // path `git worktree list` reports — no need to realpath again (and we
    // must not, since the dir is removed by archive below).
    expect(listWorktrees(mirrorPath)).toContain(ws.path);
    expect(listBranches(mirrorPath)).toContain(branch);

    // Archive is called with the REMOTE URL (as the route does, via the marker
    // override). The local checkout the URL would point at does not exist —
    // the marker's recorded mirror gitDir is what makes this work.
    archiveWorkspace(name, remote, { branch });

    expect(existsSync(ws.path)).toBe(false);
    expect(listWorktrees(mirrorPath)).not.toContain(ws.path);
    expect(listBranches(mirrorPath)).not.toContain(branch);
  });

  it("prunes a stale mirror worktree registration when the dir was removed out-of-band", () => {
    const name = "mirror-delta";
    const branch = "friday/mirror-delta";
    const mirrorPath = mirrorPathForRemote(remote);

    const ws = createWorkspace({ name, baseRepo: remote, branch });
    // Read back the marker's gitDir so the prune still targets the mirror even
    // though we wipe the dir (and its marker) out from under git below.
    const recordedGitDir = JSON.parse(
      readFileSync(join(ws.path, ".friday-workspace.json"), "utf8"),
    ).gitDir;
    expect(recordedGitDir).toBe(mirrorPath);

    rmSync(ws.path, { recursive: true, force: true });
    // git still has the registration.
    expect(listWorktrees(mirrorPath)).toContain(ws.path);

    // Marker is gone with the dir, so archive falls back to the passed repo —
    // we therefore pass the mirror path directly here to model the prune path
    // hitting the right git dir when the marker is unrecoverable.
    archiveWorkspace(name, mirrorPath, { branch });

    expect(listWorktrees(mirrorPath)).not.toContain(ws.path);
    expect(listBranches(mirrorPath)).not.toContain(branch);
  });
});
