/**
 * PR E: continuous invariant auditor. Catches impossible agent states
 * that would otherwise linger until the next daemon restart — zombie
 * builders whose worktree was deleted, rows marked `working` with no
 * live worker.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const dataRoot = mkdtempSync(join(tmpdir(), "friday-invariants-"));
process.env.FRIDAY_DATA_DIR = dataRoot;

const { runMigrations, closeDb } = await import("@friday/shared");
const registry = await import("./registry.js");
const { audit } = await import("./invariants.js");
const lifecycle = await import("./lifecycle.js");

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  closeDb();
  rmSync(dataRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  // Clean every row between tests so cases don't leak.
  for (const a of registry.listAgents()) {
    registry.archiveAgent(a.name);
  }
});

describe("invariant auditor", () => {
  it("Rule 1: archives a builder whose worktree dir is missing", () => {
    const worktreePath = join(dataRoot, "workspaces", "ghost-1");
    // Deliberately do NOT create the directory.
    registry.registerAgent({
      name: "ghost-1",
      type: "builder",
      parentName: "friday",
      worktreePath,
      branch: "friday/ghost-1",
    });
    // Force the row out of the default "idle" so the migration-skip
    // scenario is reproduced (the real bug had status=working post
    // mail-recovery).
    registry.setStatus("ghost-1", "working");

    const result = audit();

    expect(result.archived).toContain("ghost-1");
    expect(registry.getAgent("ghost-1")?.status).toBe("archived");
  });

  it("Rule 1: does NOT archive a builder whose worktree exists", () => {
    const worktreePath = join(dataRoot, "workspaces", "healthy-1");
    mkdirSync(worktreePath, { recursive: true });
    registry.registerAgent({
      name: "healthy-1",
      type: "builder",
      parentName: "friday",
      worktreePath,
      branch: "friday/healthy-1",
    });
    registry.setStatus("healthy-1", "idle");

    const result = audit();

    expect(result.archived).not.toContain("healthy-1");
    expect(registry.getAgent("healthy-1")?.status).toBe("idle");
  });

  it("Rule 1: already-archived builders with missing worktrees are left alone", () => {
    const worktreePath = join(dataRoot, "workspaces", "already-gone");
    registry.registerAgent({
      name: "already-gone",
      type: "builder",
      parentName: "friday",
      worktreePath,
      branch: "friday/already-gone",
    });
    registry.archiveAgent("already-gone");

    const result = audit();

    expect(result.archived).not.toContain("already-gone");
    expect(registry.getAgent("already-gone")?.status).toBe("archived");
  });

  it("Rule 2: demotes a `working` agent that isn't in the live map", () => {
    registry.registerAgent({
      name: "zombie-1",
      type: "bare",
    });
    registry.setStatus("zombie-1", "working");
    // Critical assumption: nothing in the live map for "zombie-1".
    vi.spyOn(lifecycle, "isAgentLive").mockImplementation(
      (name: string) => name !== "zombie-1",
    );

    const result = audit();

    expect(result.demoted).toContain("zombie-1");
    expect(registry.getAgent("zombie-1")?.status).toBe("idle");
  });

  it("Rule 2: leaves working agents alone when they ARE in the live map", () => {
    registry.registerAgent({
      name: "real-worker",
      type: "bare",
    });
    registry.setStatus("real-worker", "working");
    vi.spyOn(lifecycle, "isAgentLive").mockImplementation(
      (name: string) => name === "real-worker",
    );

    const result = audit();

    expect(result.demoted).not.toContain("real-worker");
    expect(registry.getAgent("real-worker")?.status).toBe("working");
  });

  it("Rule 1 takes precedence over Rule 2 (archive supersedes demote)", () => {
    // A builder that is BOTH working and orphan-worktree gets archived,
    // not demoted to idle. Archive is the terminal state; idle would
    // let it slip back into mail-recovery on the next boot.
    const worktreePath = join(dataRoot, "workspaces", "both-bad");
    registry.registerAgent({
      name: "both-bad",
      type: "builder",
      parentName: "friday",
      worktreePath,
      branch: "friday/both-bad",
    });
    registry.setStatus("both-bad", "working");
    vi.spyOn(lifecycle, "isAgentLive").mockReturnValue(false);

    const result = audit();

    expect(result.archived).toContain("both-bad");
    expect(result.demoted).not.toContain("both-bad");
    expect(registry.getAgent("both-bad")?.status).toBe("archived");
  });
});
