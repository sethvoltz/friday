/**
 * FIX_FORWARD 6.4: containment-check tests for the workspace destroy flow.
 *
 * `assertInsideWorkspacesRoot` is the gate that protects every rm-equivalent
 * op from nuking files outside `~/.friday/workspaces/`. The realpath dance
 * matters because a malicious or accidental symlink inside a workspace
 * could otherwise resolve to system paths.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "friday-ws-test-"));
process.env.FRIDAY_DATA_DIR = root;

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

const loggerLogMock = vi.hoisted(() => vi.fn());
vi.mock("../log.js", () => ({
  logger: { log: loggerLogMock, close: vi.fn() },
}));

// Force fresh module load with the env var + mocks set above.
const { archiveWorkspace, assertInsideWorkspacesRoot, classifyGitArchiveStderr, workspacesRoot } =
  await import("./workspace.js");

beforeAll(() => {
  mkdirSync(workspacesRoot(), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("assertInsideWorkspacesRoot", () => {
  it("accepts a workspace inside the root", () => {
    const ws = join(workspacesRoot(), "builder-a");
    mkdirSync(ws, { recursive: true });
    expect(() => assertInsideWorkspacesRoot(ws)).not.toThrow();
  });

  it("rejects the workspaces root itself", () => {
    expect(() => assertInsideWorkspacesRoot(workspacesRoot())).toThrow(/root itself/);
  });

  it("rejects an absolute path outside the workspaces root", () => {
    const outside = mkdtempSync(join(tmpdir(), "friday-ws-outside-"));
    try {
      expect(() => assertInsideWorkspacesRoot(outside)).toThrow(/outside/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a symlink that escapes the workspaces root", () => {
    const target = mkdtempSync(join(tmpdir(), "friday-ws-target-"));
    writeFileSync(join(target, "sentinel"), "");
    const link = join(workspacesRoot(), "evil-link");
    symlinkSync(target, link);
    try {
      expect(() => assertInsideWorkspacesRoot(link)).toThrow(/outside/);
    } finally {
      unlinkSync(link);
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("rejects a non-existent workspace when existsRequired is set", () => {
    const missing = join(workspacesRoot(), "never-created");
    expect(() => assertInsideWorkspacesRoot(missing)).toThrow(/not found/);
  });

  it("accepts a not-yet-created path inside the root when existsRequired is false", () => {
    const missing = join(workspacesRoot(), "tolerant-check");
    expect(() => assertInsideWorkspacesRoot(missing, { existsRequired: false })).not.toThrow();
  });
});

describe("classifyGitArchiveStderr", () => {
  it("recognizes the worktree-already-removed race", () => {
    expect(classifyGitArchiveStderr("fatal: '/foo/bar' is not a working tree")).toBe(
      "worktree-gone",
    );
  });

  it("recognizes the branch-already-deleted race", () => {
    expect(classifyGitArchiveStderr("error: branch 'foo' not found")).toBe("branch-gone");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["unrelated stderr", "fatal: bad object HEAD"],
    ["permission denied", "fatal: could not lock config file"],
  ] as const)("returns null for %s", (_label, input) => {
    expect(classifyGitArchiveStderr(input)).toBeNull();
  });
});

describe("archiveWorkspace catch-block logging", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    loggerLogMock.mockReset();
  });

  function makeExecError(stderr: string): Error & { stderr: Buffer } {
    const err = new Error("Command failed") as Error & { stderr: Buffer };
    err.stderr = Buffer.from(stderr);
    return err;
  }

  it("demotes worktree-already-removed race to debug + .skip event", () => {
    const ws = join(workspacesRoot(), "race-worktree");
    mkdirSync(ws, { recursive: true });
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[]) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        throw makeExecError("fatal: '/tmp/foo' is not a working tree");
      }
      return Buffer.from("");
    });

    archiveWorkspace("race-worktree", "/fake-repo");

    const destroyCalls = loggerLogMock.mock.calls.filter(
      (c) => c[1] === "workspace.destroy.skip" || c[1] === "workspace.destroy.fail",
    );
    expect(destroyCalls).toHaveLength(1);
    expect(destroyCalls[0]?.[0]).toBe("debug");
    expect(destroyCalls[0]?.[1]).toBe("workspace.destroy.skip");
    expect(destroyCalls[0]?.[2]).toMatchObject({
      name: "race-worktree",
      reason: "worktree-gone",
    });
  });

  it("demotes branch-already-deleted race to debug + .skip event", () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return Buffer.from("");
      if (args[0] === "branch" && args[1] === "-D") {
        throw makeExecError("error: branch 'fix/bar' not found.");
      }
      return Buffer.from("");
    });

    archiveWorkspace("never-existed", "/fake-repo", { branch: "fix/bar" });

    const branchCalls = loggerLogMock.mock.calls.filter(
      (c) => c[1] === "workspace.branch.delete.skip" || c[1] === "workspace.branch.delete.fail",
    );
    expect(branchCalls).toHaveLength(1);
    expect(branchCalls[0]?.[0]).toBe("debug");
    expect(branchCalls[0]?.[1]).toBe("workspace.branch.delete.skip");
    expect(branchCalls[0]?.[2]).toMatchObject({
      name: "never-existed",
      branch: "fix/bar",
      reason: "branch-gone",
    });
  });

  it("keeps unrecognized worktree-remove stderr at warn + .fail event", () => {
    const ws = join(workspacesRoot(), "real-failure");
    mkdirSync(ws, { recursive: true });
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[]) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        throw makeExecError("fatal: could not lock config file .git/config: Permission denied");
      }
      return Buffer.from("");
    });

    archiveWorkspace("real-failure", "/fake-repo");

    const destroyCalls = loggerLogMock.mock.calls.filter(
      (c) => c[1] === "workspace.destroy.skip" || c[1] === "workspace.destroy.fail",
    );
    expect(destroyCalls).toHaveLength(1);
    expect(destroyCalls[0]?.[0]).toBe("warn");
    expect(destroyCalls[0]?.[1]).toBe("workspace.destroy.fail");
    expect(destroyCalls[0]?.[2]).toMatchObject({
      name: "real-failure",
      stderr: "fatal: could not lock config file .git/config: Permission denied",
    });
  });

  it("keeps unrecognized branch-delete stderr at warn + .fail event", () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return Buffer.from("");
      if (args[0] === "branch" && args[1] === "-D") {
        throw makeExecError("fatal: unable to access '/repo/.git/': permission denied");
      }
      return Buffer.from("");
    });

    archiveWorkspace("branch-failure", "/fake-repo", { branch: "fix/baz" });

    const branchCalls = loggerLogMock.mock.calls.filter(
      (c) => c[1] === "workspace.branch.delete.skip" || c[1] === "workspace.branch.delete.fail",
    );
    expect(branchCalls).toHaveLength(1);
    expect(branchCalls[0]?.[0]).toBe("warn");
    expect(branchCalls[0]?.[1]).toBe("workspace.branch.delete.fail");
    expect(branchCalls[0]?.[2]).toMatchObject({
      name: "branch-failure",
      branch: "fix/baz",
      stderr: "fatal: unable to access '/repo/.git/': permission denied",
    });
  });

  it("keeps stderr-less failures (e.g. ENOENT) at warn", () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return Buffer.from("");
      if (args[0] === "branch" && args[1] === "-D") {
        throw new Error("spawn git ENOENT");
      }
      return Buffer.from("");
    });

    archiveWorkspace("no-stderr-failure", "/fake-repo", { branch: "fix/qux" });

    const branchCalls = loggerLogMock.mock.calls.filter(
      (c) => c[1] === "workspace.branch.delete.skip" || c[1] === "workspace.branch.delete.fail",
    );
    expect(branchCalls).toHaveLength(1);
    expect(branchCalls[0]?.[0]).toBe("warn");
    expect(branchCalls[0]?.[1]).toBe("workspace.branch.delete.fail");
  });

  it("forces LC_ALL=C on the parsed git invocations so substring match is locale-stable", () => {
    const ws = join(workspacesRoot(), "locale-check");
    mkdirSync(ws, { recursive: true });
    execFileSyncMock.mockReturnValue(Buffer.from(""));

    archiveWorkspace("locale-check", "/fake-repo", { branch: "fix/locale" });

    const parsedCalls = execFileSyncMock.mock.calls.filter((c) => {
      const args = c[1] as readonly string[];
      return (
        (args[0] === "worktree" && args[1] === "remove") ||
        (args[0] === "branch" && args[1] === "-D")
      );
    });
    expect(parsedCalls.length).toBeGreaterThan(0);
    for (const call of parsedCalls) {
      const opts = call[2] as { env?: Record<string, string> };
      expect(opts.env?.LC_ALL).toBe("C");
      expect(opts.env?.LANG).toBe("C");
    }
  });
});
