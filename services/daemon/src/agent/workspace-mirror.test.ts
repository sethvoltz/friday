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

  it("derives a readable basename prefix plus a URL-derived hash suffix", () => {
    // The prefix is the basename minus `.git`; the 8-hex suffix disambiguates
    // distinct remotes that share a basename (MEDIUM 3).
    expect(mirrorNameFromRemote("https://github.com/org/agent-friday.git")).toMatch(
      /^agent-friday-[0-9a-f]{8}$/,
    );
    expect(mirrorNameFromRemote("/some/path/repo.git/")).toMatch(/^repo-[0-9a-f]{8}$/);
  });

  it("folds cosmetic URL differences (trailing slash / .git) so the same remote hashes identically", () => {
    const a = mirrorNameFromRemote("https://github.com/org/agent-friday.git");
    const b = mirrorNameFromRemote("https://github.com/org/agent-friday");
    const c = mirrorNameFromRemote("https://github.com/org/agent-friday/");
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("gives distinct remotes that share a basename distinct names (MEDIUM 3)", () => {
    expect(mirrorNameFromRemote("https://github.com/orgA/shared.git")).not.toBe(
      mirrorNameFromRemote("https://github.com/orgB/shared.git"),
    );
  });

  it("resolves the mirror path under <DATA_DIR>/repos/<name>.git", () => {
    expect(mirrorPathForRemote("https://github.com/org/agent-friday.git")).toBe(
      join(reposRoot(), `${mirrorNameFromRemote("https://github.com/org/agent-friday.git")}.git`),
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

    // Mirror was created under <DATA_DIR>/repos/ with the hashed name.
    expect(mirrorPath).toBe(join(reposRoot(), `${mirrorNameFromRemote(remote)}.git`));
    expect(mirrorNameFromRemote(remote)).toMatch(/^remote-origin-[0-9a-f]{8}$/);
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

// PR-271 BLOCKER 1/2 regression suite. The original "prunes a stale mirror
// worktree registration" test above passes `mirrorPath` directly as baseRepo,
// which does NOT model the real route caller: production passes the original
// source `repo` and (pre-fix) `baseRepo = process.cwd()`. These tests
// reproduce the PRODUCTION path — workspace dir removed out-of-band so the
// marker is gone — and assert teardown targets the MIRROR via `opts.repo`,
// NEVER `process.cwd()`.
describe("archiveWorkspace (production route path — BLOCKER 1)", () => {
  it("targets the mirror when the workspace dir (and its marker) is already gone, leaving an unrelated repo UNTOUCHED", () => {
    const name = "mirror-prod-1";
    const branch = "friday/mirror-prod-1";
    const mirrorPath = mirrorPathForRemote(remote);

    const ws = createWorkspace({ name, baseRepo: remote, branch });
    expect(listWorktrees(mirrorPath)).toContain(ws.path);
    expect(listBranches(mirrorPath)).toContain(branch);

    // Build a CONTROL repo standing in for `process.cwd()` (the daemon's own
    // repo). Give it a branch of the SAME name; pre-fix the teardown's branch
    // -D / worktree prune ran here and would delete this branch.
    const controlRepo = realpathSync(mkdtempSync(join(tmpdir(), "friday-ws-control-")));
    execFileSync("git", ["init", "-q", "-b", "main", controlRepo]);
    gitIn(controlRepo, ["config", "user.email", "c@example.com"]);
    gitIn(controlRepo, ["config", "user.name", "C"]);
    writeFileSync(join(controlRepo, "f.txt"), "x\n");
    gitIn(controlRepo, ["add", "f.txt"]);
    gitIn(controlRepo, ["commit", "-q", "-m", "c"]);
    gitIn(controlRepo, ["branch", branch]);
    expect(listBranches(controlRepo)).toContain(branch);

    // SDK removed the worktree dir (and its marker) before archive runs.
    rmSync(ws.path, { recursive: true, force: true });
    expect(existsSync(join(ws.path, ".friday-workspace.json"))).toBe(false);
    // Mirror still has the dangling registration.
    expect(listWorktrees(mirrorPath)).toContain(ws.path);

    // The real route: baseRepo is the daemon's cwd (here `controlRepo`), and
    // the AUTHORITATIVE original repo is passed via opts.repo.
    const prevCwd = process.cwd();
    process.chdir(controlRepo);
    try {
      archiveWorkspace(name, controlRepo, { branch, repo: remote });
    } finally {
      process.chdir(prevCwd);
    }

    // Teardown hit the MIRROR: registration pruned, branch deleted there.
    expect(listWorktrees(mirrorPath)).not.toContain(ws.path);
    expect(listBranches(mirrorPath)).not.toContain(branch);
    // The control repo (daemon's own repo) is UNTOUCHED — its same-named
    // branch survives.
    expect(listBranches(controlRepo)).toContain(branch);

    rmSync(controlRepo, { recursive: true, force: true });
  });

  it("re-creates a same-named builder after an out-of-band dir removal (BLOCKER 2)", () => {
    const name = "mirror-prod-2";
    const branch = "friday/mirror-prod-2";
    const mirrorPath = mirrorPathForRemote(remote);

    const ws1 = createWorkspace({ name, baseRepo: remote, branch });
    expect(listWorktrees(mirrorPath)).toContain(ws1.path);

    // Dir vanishes out-of-band, leaving a dangling worktree registration that
    // pre-fix wedged the next create with "missing but already registered".
    rmSync(ws1.path, { recursive: true, force: true });
    expect(listWorktrees(mirrorPath)).toContain(ws1.path);

    // Re-create the SAME builder name → must succeed (create-path prune).
    let ws2: ReturnType<typeof createWorkspace> | undefined;
    expect(() => {
      ws2 = createWorkspace({ name, baseRepo: remote, branch });
    }).not.toThrow();
    expect(ws2).toBeDefined();
    expect(existsSync(ws2!.path)).toBe(true);
    expect(listWorktrees(mirrorPath)).toContain(ws2!.path);
    expect(listBranches(mirrorPath)).toContain(branch);

    archiveWorkspace(name, remote, { branch, repo: remote });
  });
});

describe("mirror name collision (MEDIUM 3)", () => {
  it("maps two distinct remotes sharing a basename to DISTINCT mirrors with the correct codebase each", () => {
    // Two bare remotes both named `shared.git` under different parent dirs,
    // each with a uniquely-named file so we can tell which codebase a worktree
    // rooted on.
    function makeRemote(org: string, marker: string): string {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), `friday-ws-${org}-`)));
      const bare = join(dir, "shared.git");
      execFileSync("git", ["init", "--bare", "-b", "main", bare]);
      const seed = join(dir, "seed");
      execFileSync("git", ["clone", "-q", bare, seed]);
      gitIn(seed, ["config", "user.email", "t@example.com"]);
      gitIn(seed, ["config", "user.name", "T"]);
      writeFileSync(join(seed, marker), "x\n");
      gitIn(seed, ["add", marker]);
      gitIn(seed, ["commit", "-q", "-m", "seed"]);
      gitIn(seed, ["push", "-q", "origin", "main"]);
      return bare;
    }

    const remoteA = makeRemote("orgA", "FROM_ORG_A");
    const remoteB = makeRemote("orgB", "FROM_ORG_B");

    // Distinct basenames? No — both basename to `shared`. The hash must split
    // them so the derived mirror paths differ.
    expect(mirrorNameFromRemote(remoteA)).not.toBe(mirrorNameFromRemote(remoteB));
    const mirrorA = mirrorPathForRemote(remoteA);
    const mirrorB = mirrorPathForRemote(remoteB);
    expect(mirrorA).not.toBe(mirrorB);

    const wsA = createWorkspace({ name: "shared-a", baseRepo: remoteA, branch: "friday/shared-a" });
    const wsB = createWorkspace({ name: "shared-b", baseRepo: remoteB, branch: "friday/shared-b" });

    // Each worktree rooted on the CORRECT codebase.
    expect(existsSync(join(wsA.path, "FROM_ORG_A"))).toBe(true);
    expect(existsSync(join(wsA.path, "FROM_ORG_B"))).toBe(false);
    expect(existsSync(join(wsB.path, "FROM_ORG_B"))).toBe(true);
    expect(existsSync(join(wsB.path, "FROM_ORG_A"))).toBe(false);

    archiveWorkspace("shared-a", remoteA, { branch: "friday/shared-a", repo: remoteA });
    archiveWorkspace("shared-b", remoteB, { branch: "friday/shared-b", repo: remoteB });
  });
});

describe("clone hardening (LOW/MEDIUM 4)", () => {
  it("rejects a remote that begins with '-'", () => {
    expect(() =>
      createWorkspace({ name: "evil-1", baseRepo: "--upload-pack=touch /tmp/x", branch: "b" }),
    ).toThrow(/begins with '-'/);
  });

  it("rejects an ext:: transport-helper remote", () => {
    expect(() =>
      createWorkspace({ name: "evil-2", baseRepo: "ext::sh -c 'touch /tmp/x'", branch: "b" }),
    ).toThrow(/transport-helper/);
  });
});
