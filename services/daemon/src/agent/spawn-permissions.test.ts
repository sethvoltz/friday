/**
 * ADR-022 / FRI-102 — spawn-permission gates, lineage telemetry, and
 * watchdog refork preservation.
 *
 * The HTTP path (`POST /api/agents`) is a thin composition of
 * `validateSpawnPermissions`, `computeSpawnDepth`, `registry.registerAgent`,
 * and a `logger.log("info", "agent.spawn", …)` call. Tests target the
 * underlying helpers and the registry surface; the wiring in
 * `api/server.ts` is short and inspectable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";
import type { AgentEntry } from "@friday/shared";

let handle: TestDbHandle;
let registry: typeof import("./registry.js");
let perms: typeof import("./spawn-permissions.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "spawn-permissions" });
  perms = await import("./spawn-permissions.js");
  registry = await import("./registry.js");
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

describe("validateSpawnPermissions (ADR-022 §6 #4 #5)", () => {
  it("orchestrator → builder is allowed with no reason", () => {
    expect(perms.validateSpawnPermissions({ type: "builder" }, "orchestrator")).toBeNull();
  });

  it("orchestrator → helper is allowed with no reason", () => {
    expect(perms.validateSpawnPermissions({ type: "helper" }, "orchestrator")).toBeNull();
  });

  it("orchestrator → bare is allowed with no reason", () => {
    expect(perms.validateSpawnPermissions({ type: "bare" }, "orchestrator")).toBeNull();
  });

  it("builder → helper with non-empty reason is allowed", () => {
    expect(
      perms.validateSpawnPermissions(
        { type: "helper", reason: "digest the upstream RFC" },
        "builder",
      ),
    ).toBeNull();
  });

  it("helper → helper with non-empty reason is allowed", () => {
    expect(
      perms.validateSpawnPermissions(
        { type: "helper", reason: "parallel contract checks" },
        "helper",
      ),
    ).toBeNull();
  });

  it("builder → builder is rejected 403 BUILDER_SPAWN_ORCHESTRATOR_ONLY", () => {
    const rej = perms.validateSpawnPermissions({ type: "builder", reason: "x" }, "builder");
    expect(rej).toEqual({
      status: 403,
      body: {
        error: "only the orchestrator can spawn builders",
        code: "BUILDER_SPAWN_ORCHESTRATOR_ONLY",
      },
    });
  });

  it("helper → builder is rejected 403 BUILDER_SPAWN_ORCHESTRATOR_ONLY", () => {
    const rej = perms.validateSpawnPermissions({ type: "builder", reason: "x" }, "helper");
    expect(rej).toEqual({
      status: 403,
      body: {
        error: "only the orchestrator can spawn builders",
        code: "BUILDER_SPAWN_ORCHESTRATOR_ONLY",
      },
    });
  });

  it("builder → bare is also rejected 403 (only helpers allowed from non-orch)", () => {
    const rej = perms.validateSpawnPermissions({ type: "bare", reason: "x" }, "builder");
    expect(rej?.status).toBe(403);
    expect(rej?.body.code).toBe("BUILDER_SPAWN_ORCHESTRATOR_ONLY");
  });

  it("builder → helper without reason is rejected 400 SPAWN_REASON_REQUIRED", () => {
    const rej = perms.validateSpawnPermissions({ type: "helper" }, "builder");
    expect(rej).toEqual({
      status: 400,
      body: {
        error: "reason required when spawner is not the orchestrator",
        code: "SPAWN_REASON_REQUIRED",
      },
    });
  });

  it("helper → helper without reason is rejected 400 SPAWN_REASON_REQUIRED", () => {
    const rej = perms.validateSpawnPermissions({ type: "helper" }, "helper");
    expect(rej).toEqual({
      status: 400,
      body: {
        error: "reason required when spawner is not the orchestrator",
        code: "SPAWN_REASON_REQUIRED",
      },
    });
  });

  it("builder → helper with whitespace-only reason is rejected 400 SPAWN_REASON_REQUIRED", () => {
    const rej = perms.validateSpawnPermissions({ type: "helper", reason: "   \t\n  " }, "builder");
    expect(rej).toEqual({
      status: 400,
      body: {
        error: "reason required when spawner is not the orchestrator",
        code: "SPAWN_REASON_REQUIRED",
      },
    });
  });

  it("builder → helper with null reason is rejected 400 SPAWN_REASON_REQUIRED", () => {
    const rej = perms.validateSpawnPermissions({ type: "helper", reason: null }, "builder");
    expect(rej?.status).toBe(400);
    expect(rej?.body.code).toBe("SPAWN_REASON_REQUIRED");
  });

  // FRI-40: the evolve auto-triage hook spawns with parentName
  // "scheduled-meta-daily", whose registry row resolves callerType="scheduled".
  // The triage helper must pass the gate as a helper-with-reason WITHOUT any
  // edit to spawn-permissions.ts (the "scheduled" caller is just a
  // non-orchestrator caller, gated identically to builder/helper).
  it("scheduled → helper with the auto-triage reason is allowed (FRI-40)", () => {
    expect(
      perms.validateSpawnPermissions(
        {
          type: "helper",
          reason: "evolve auto-triage: proposal p_x-aaaa promoted to critical (signal worker.exit)",
        },
        "scheduled",
      ),
    ).toBeNull();
  });

  it("scheduled → helper with empty reason is rejected 400 SPAWN_REASON_REQUIRED (FRI-40)", () => {
    const rej = perms.validateSpawnPermissions({ type: "helper", reason: "" }, "scheduled");
    expect(rej).toEqual({
      status: 400,
      body: {
        error: "reason required when spawner is not the orchestrator",
        code: "SPAWN_REASON_REQUIRED",
      },
    });
  });

  it("scheduled → builder is rejected 403 BUILDER_SPAWN_ORCHESTRATOR_ONLY (FRI-40 Phase 2 guard)", () => {
    const rej = perms.validateSpawnPermissions({ type: "builder", reason: "x" }, "scheduled");
    expect(rej).toEqual({
      status: 403,
      body: {
        error: "only the orchestrator can spawn builders",
        code: "BUILDER_SPAWN_ORCHESTRATOR_ONLY",
      },
    });
  });
});

describe("computeSpawnDepth (ADR-022 §6 #7 #30)", () => {
  const buildGetAgent = (rows: Record<string, { type: string; parentName?: string | null }>) => {
    return async (name: string): Promise<AgentEntry | null> => {
      const r = rows[name];
      if (!r) return null;
      return {
        name,
        type: r.type,
        status: "idle",
        parentName: r.parentName ?? undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as AgentEntry;
    };
  };

  it("returns depth=1, parentChain=[] when parentName is undefined", async () => {
    const result = await perms.computeSpawnDepth(undefined, buildGetAgent({}));
    expect(result).toEqual({ depth: 1, parentChain: [] });
  });

  it("returns depth=1, parentChain=[] when parentName is null", async () => {
    const result = await perms.computeSpawnDepth(null, buildGetAgent({}));
    expect(result).toEqual({ depth: 1, parentChain: [] });
  });

  it("Helper spawned directly by orchestrator → depth=2, parentChain=[orch]", async () => {
    const rows = {
      friday: { type: "orchestrator" },
    };
    const result = await perms.computeSpawnDepth("friday", buildGetAgent(rows));
    expect(result).toEqual({ depth: 2, parentChain: ["friday"] });
  });

  it("Helper spawned by a Builder → depth=3, parentChain=[orch, builder]", async () => {
    const rows = {
      friday: { type: "orchestrator" },
      "builder-A": { type: "builder", parentName: "friday" },
    };
    const result = await perms.computeSpawnDepth("builder-A", buildGetAgent(rows));
    expect(result).toEqual({
      depth: 3,
      parentChain: ["friday", "builder-A"],
    });
  });

  it("Helper-C in orch → builder-A → helper-B → helper-C lineage → depth=4, parentChain=[orch, builder-A, helper-B]", async () => {
    const rows = {
      friday: { type: "orchestrator" },
      "builder-A": { type: "builder", parentName: "friday" },
      "helper-B": { type: "helper", parentName: "builder-A" },
    };
    const result = await perms.computeSpawnDepth("helper-B", buildGetAgent(rows));
    expect(result).toEqual({
      depth: 4,
      parentChain: ["friday", "builder-A", "helper-B"],
    });
  });

  it("17-deep synthetic chain caps parentChain at 16; depth still counts true distance", async () => {
    // Construct a chain of 16 ancestors above the new spawn:
    //   friday → h-1 → h-2 → … → h-15 (parent of the new spawn)
    // The new spawn would land at depth 17. Cap = 16; the chain has
    // exactly 16 entries (friday + h-1 … h-15) so the cap is hit but
    // the chain is fully preserved at the boundary.
    const rows: Record<string, { type: string; parentName?: string }> = {
      friday: { type: "orchestrator" },
    };
    let prev = "friday";
    for (let i = 1; i <= 15; i++) {
      const name = `h-${i}`;
      rows[name] = { type: "helper", parentName: prev };
      prev = name;
    }
    const result = await perms.computeSpawnDepth(prev, buildGetAgent(rows));
    expect(result.depth).toBe(17);
    expect(result.parentChain.length).toBe(16);
    expect(result.parentChain[0]).toBe("friday");
    expect(result.parentChain[15]).toBe("h-15");
  });

  it("truncates parentChain to 16 oldest entries when chain exceeds the cap; depth = true distance", async () => {
    // 20-deep chain: 19 ancestors + 1 new spawn. Cap removes the 3
    // most-recent ancestors; depth still reports 20.
    const rows: Record<string, { type: string; parentName?: string }> = {
      friday: { type: "orchestrator" },
    };
    let prev = "friday";
    for (let i = 1; i <= 18; i++) {
      const name = `h-${i}`;
      rows[name] = { type: "helper", parentName: prev };
      prev = name;
    }
    const result = await perms.computeSpawnDepth(prev, buildGetAgent(rows));
    expect(result.depth).toBe(20);
    expect(result.parentChain.length).toBe(16);
    // Oldest-first orchestrator-rooted slice survives.
    expect(result.parentChain[0]).toBe("friday");
    expect(result.parentChain[15]).toBe("h-15");
  });

  it("handles a missing parent row by halting the walk", async () => {
    // parent points at a name that doesn't exist; the walker records
    // the parent itself, fails to read its parentName, and stops.
    const rows: Record<string, { type: string; parentName?: string }> = {};
    const result = await perms.computeSpawnDepth("orphan", buildGetAgent(rows));
    expect(result.depth).toBe(2);
    expect(result.parentChain).toEqual(["orphan"]);
  });
});

describe("registry.registerAgent persists spawn_reason (ADR-022 §6 #6)", () => {
  it("orchestrator-implicit spawn keeps spawn_reason NULL", async () => {
    const row = await registry.registerAgent({
      name: "orch-direct",
      type: "helper",
      parentName: "friday",
    });
    expect(row.name).toBe("orch-direct");
    expect(await registry.getSpawnReason("orch-direct")).toBeNull();
  });

  it("spawn with spawnReason persists the trimmed string", async () => {
    await registry.registerAgent({
      name: "rationale-helper",
      type: "helper",
      parentName: "builder-A",
      spawnReason: "digest the upstream RFC",
    });
    expect(await registry.getSpawnReason("rationale-helper")).toBe("digest the upstream RFC");
  });

  it("explicit null spawnReason persists as NULL", async () => {
    await registry.registerAgent({
      name: "explicit-null",
      type: "helper",
      parentName: "friday",
      spawnReason: null,
    });
    expect(await registry.getSpawnReason("explicit-null")).toBeNull();
  });

  it("getSpawnReason returns null for a missing agent", async () => {
    expect(await registry.getSpawnReason("does-not-exist")).toBeNull();
  });
});

describe("watchdog refork preserves spawn_reason (ADR-022 §6 #11 #33)", () => {
  it("forceWorkerRefork leaves spawn_reason and ticket fields untouched", async () => {
    // The watchdog refork path used to archive → re-register; both touched
    // (or threatened to touch) spawn_reason. The new path skips the
    // archive write entirely and the row is never replaced, so the audit
    // column survives by simple non-mutation. Exercise that contract:
    // register, refork (no live worker — exit path is a no-op except for
    // the setStatus('idle') terminal write), assert all the
    // long-lived-row columns are intact.
    const { forceWorkerRefork } = await import("./lifecycle.js");
    await registry.registerAgent({
      name: "refork-pin",
      type: "helper",
      parentName: "builder-A",
      spawnReason: "test-refork-pin",
    });

    await forceWorkerRefork("refork-pin");

    expect(await registry.getSpawnReason("refork-pin")).toBe("test-refork-pin");
    const row = await registry.getAgent("refork-pin");
    expect(row?.status).toBe("idle");
    expect(row?.type).toBe("helper");
    expect(row && "parentName" in row ? row.parentName : null).toBe("builder-A");
  });
});
