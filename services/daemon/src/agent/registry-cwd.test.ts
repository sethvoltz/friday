/**
 * FRI-16 AC #15 — `workingDirectoryFor` planner parent-inheritance.
 *
 * Planners inherit their parent's cwd (resolved recursively through
 * `parentName`); archived/missing parents fall back to the planner's own
 * per-agent home; a corrupted planner→planner parent cycle is bounded at
 * 8 hops and logs `registry.cwd.cycle-bounded`.
 *
 * Planner rows insert directly: shared migration 0032 widens the
 * `agents_type_check` CHECK constraint to include 'planner', and
 * createTestDb applies the full migration set to the scratch DB.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Bind the data dir BEFORE any @friday/shared machinery loads — AGENTS_DIR
// (per-agent homes, mkdir'd by workingDirectoryFor) derives from DATA_DIR
// at import time.
process.env.FRIDAY_DATA_DIR = mkdtempSync(join(tmpdir(), "fri16-registry-cwd-"));

const logMock = vi.fn();
vi.mock("../log.js", () => ({
  logger: { log: logMock },
}));

const { createTestDb, AGENTS_DIR } = await import("@friday/shared");
type TestDbHandle = import("@friday/shared").TestDbHandle;

let handle: TestDbHandle;
let registry: typeof import("./registry.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "registry-cwd" });
  registry = await import("./registry.js");
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  logMock.mockClear();
});

describe("workingDirectoryFor: planner parent-inheritance (FRI-16 AC #15)", () => {
  it("planner under a builder inherits the builder's worktree", async () => {
    await registry.registerAgent({
      name: "builder-x",
      type: "builder",
      parentName: "friday",
      worktreePath: "/x/y",
    });
    await registry.registerAgent({
      name: "planner-1",
      type: "planner",
      parentName: "builder-x",
      spawnReason: "deep planning",
    });

    const planner = await registry.getAgent("planner-1");
    // Pins rowToEntry's planner arm: type + parentName survive the round-trip.
    expect(planner).toMatchObject({ name: "planner-1", type: "planner", parentName: "builder-x" });

    expect(await registry.workingDirectoryFor(planner!)).toBe("/x/y");
  });

  it("planner under the orchestrator inherits the orchestrator's per-agent home", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    await registry.registerAgent({
      name: "planner-2",
      type: "planner",
      parentName: "friday",
    });

    const planner = await registry.getAgent("planner-2");
    expect(await registry.workingDirectoryFor(planner!)).toBe(join(AGENTS_DIR, "friday"));
  });

  it("planner whose parent is archived gets its OWN per-agent home (never a dead worktree)", async () => {
    await registry.registerAgent({
      name: "builder-dead",
      type: "builder",
      parentName: "friday",
      worktreePath: "/dead/worktree",
    });
    await registry.setStatus("builder-dead", "archived", { archiveReason: "abandoned" });
    await registry.registerAgent({
      name: "planner-3",
      type: "planner",
      parentName: "builder-dead",
    });

    const planner = await registry.getAgent("planner-3");
    expect(await registry.workingDirectoryFor(planner!)).toBe(join(AGENTS_DIR, "planner-3"));
  });

  it("planner whose parent row is missing gets its OWN per-agent home", async () => {
    await registry.registerAgent({
      name: "planner-4",
      type: "planner",
      parentName: "ghost-parent",
    });

    const planner = await registry.getAgent("planner-4");
    expect(await registry.workingDirectoryFor(planner!)).toBe(join(AGENTS_DIR, "planner-4"));
  });

  it("planner→planner parent cycle is bounded at 8 hops, falls back to the per-agent home, and logs registry.cwd.cycle-bounded", async () => {
    await registry.registerAgent({
      name: "planner-a",
      type: "planner",
      parentName: "planner-b",
    });
    await registry.registerAgent({
      name: "planner-b",
      type: "planner",
      parentName: "planner-a",
    });

    const plannerA = await registry.getAgent("planner-a");
    // 8 hops from planner-a lands back on planner-a (even hop count in a
    // 2-cycle), so the bounded fallback is planner-a's own home.
    expect(await registry.workingDirectoryFor(plannerA!)).toBe(join(AGENTS_DIR, "planner-a"));
    expect(logMock).toHaveBeenCalledWith(
      "warn",
      "registry.cwd.cycle-bounded",
      expect.objectContaining({ agent: "planner-a", parent: "planner-b", hops: 8 }),
    );
  });

  it("non-planner resolution is unchanged: builder → worktree, helper → per-agent home", async () => {
    await registry.registerAgent({
      name: "builder-z",
      type: "builder",
      parentName: "friday",
      worktreePath: "/z/worktree",
    });
    await registry.registerAgent({ name: "helper-z", type: "helper", parentName: "friday" });

    expect(await registry.workingDirectoryFor((await registry.getAgent("builder-z"))!)).toBe(
      "/z/worktree",
    );
    expect(await registry.workingDirectoryFor((await registry.getAgent("helper-z"))!)).toBe(
      join(AGENTS_DIR, "helper-z"),
    );
  });
});
