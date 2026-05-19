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
import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;
let workspaceRoot: string;
let registry: typeof import("./registry.js");
let audit: typeof import("./invariants.js")["audit"];
let lifecycle: typeof import("./lifecycle.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "invariants" });
  workspaceRoot = mkdtempSync(join(tmpdir(), "friday-invariants-ws-"));
  registry = await import("./registry.js");
  ({ audit } = await import("./invariants.js"));
  lifecycle = await import("./lifecycle.js");
});

afterAll(async () => {
  await handle.drop();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await handle.truncate();
});

afterEach(async () => {
  // Belt-and-braces — most state lives in the registry table which the
  // beforeEach truncate already clears.
  for (const a of await registry.listAgents()) {
    await registry.archiveAgent(a.name);
  }
});

describe("invariant auditor", () => {
  it("Rule 1: archives a builder whose worktree dir is missing", async () => {
    const worktreePath = join(workspaceRoot, "ghost-1");
    // Deliberately do NOT create the directory.
    await registry.registerAgent({
      name: "ghost-1",
      type: "builder",
      parentName: "friday",
      worktreePath,
      branch: "friday/ghost-1",
    });
    // Force the row out of the default "idle" so the migration-skip
    // scenario is reproduced (the real bug had status=working post
    // mail-recovery).
    await registry.setStatus("ghost-1", "working");

    const result = await audit();

    expect(result.archived).toContain("ghost-1");
    expect((await registry.getAgent("ghost-1"))?.status).toBe("archived");
  });

  it("Rule 1: does NOT archive a builder whose worktree exists", async () => {
    const worktreePath = join(workspaceRoot, "healthy-1");
    mkdirSync(worktreePath, { recursive: true });
    await registry.registerAgent({
      name: "healthy-1",
      type: "builder",
      parentName: "friday",
      worktreePath,
      branch: "friday/healthy-1",
    });
    await registry.setStatus("healthy-1", "idle");

    const result = await audit();

    expect(result.archived).not.toContain("healthy-1");
    expect((await registry.getAgent("healthy-1"))?.status).toBe("idle");
  });

  it("Rule 1: already-archived builders with missing worktrees are left alone", async () => {
    const worktreePath = join(workspaceRoot, "already-gone");
    await registry.registerAgent({
      name: "already-gone",
      type: "builder",
      parentName: "friday",
      worktreePath,
      branch: "friday/already-gone",
    });
    await registry.archiveAgent("already-gone");

    const result = await audit();

    expect(result.archived).not.toContain("already-gone");
    expect((await registry.getAgent("already-gone"))?.status).toBe("archived");
  });

  it("Rule 2: demotes a `working` agent that isn't in the live map", async () => {
    await registry.registerAgent({
      name: "zombie-1",
      type: "bare",
    });
    await registry.setStatus("zombie-1", "working");
    // Critical assumption: nothing in the live map for "zombie-1".
    vi.spyOn(lifecycle, "isAgentLive").mockImplementation(
      (name: string) => name !== "zombie-1",
    );

    const result = await audit();

    expect(result.demoted).toContain("zombie-1");
    expect((await registry.getAgent("zombie-1"))?.status).toBe("idle");
  });

  it("Rule 2: leaves working agents alone when they ARE in the live map", async () => {
    await registry.registerAgent({
      name: "real-worker",
      type: "bare",
    });
    await registry.setStatus("real-worker", "working");
    vi.spyOn(lifecycle, "isAgentLive").mockImplementation(
      (name: string) => name === "real-worker",
    );

    const result = await audit();

    expect(result.demoted).not.toContain("real-worker");
    expect((await registry.getAgent("real-worker"))?.status).toBe("working");
  });

  it("Rule 1 takes precedence over Rule 2 (archive supersedes demote)", async () => {
    // A builder that is BOTH working and orphan-worktree gets archived,
    // not demoted to idle. Archive is the terminal state; idle would
    // let it slip back into mail-recovery on the next boot.
    const worktreePath = join(workspaceRoot, "both-bad");
    await registry.registerAgent({
      name: "both-bad",
      type: "builder",
      parentName: "friday",
      worktreePath,
      branch: "friday/both-bad",
    });
    await registry.setStatus("both-bad", "working");
    vi.spyOn(lifecycle, "isAgentLive").mockReturnValue(false);

    const result = await audit();

    expect(result.archived).toContain("both-bad");
    expect(result.demoted).not.toContain("both-bad");
    expect((await registry.getAgent("both-bad"))?.status).toBe("archived");
  });
});
