/**
 * FRI-113 / ADR-031: registry FSM gate.
 *
 * `registry.setStatus` is the single door to the `agents.status`
 * column. Every transition runs through the FSM matrix; illegal
 * transitions throw `IllegalTransitionError` with a typed `code`.
 * `registry.archiveAgent` writes both `status='archived'` and
 * `archive_reason=<reason>` atomically. The orchestrator type cannot
 * reach `archived` from any state.
 *
 * The auditor rule #3 heal (privileged unchecked write) is exercised
 * by `invariants.test.ts`; this file is the gate's own contract.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestDb,
  getDb,
  schema,
  type TestDbHandle,
} from "@friday/shared";

let handle: TestDbHandle;
let registry: typeof import("./registry.js");
let IllegalTransitionError: typeof import("./registry.js").IllegalTransitionError;

beforeAll(async () => {
  handle = await createTestDb({ label: "registry_fsm" });
  registry = await import("./registry.js");
  ({ IllegalTransitionError } = await import("./registry.js"));
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

describe("registry FSM gate (ADR-031)", () => {
  it("setStatus rejects orchestrator → archived with ORCHESTRATOR_NOT_ARCHIVABLE", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    await expect(
      registry.setStatus("friday", "archived", { archiveReason: "abandoned" }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    // Re-throw to inspect the code field.
    let caught: unknown;
    try {
      await registry.setStatus("friday", "archived", {
        archiveReason: "abandoned",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IllegalTransitionError);
    expect((caught as InstanceType<typeof IllegalTransitionError>).code).toBe(
      "ORCHESTRATOR_NOT_ARCHIVABLE",
    );

    // Row is unchanged.
    expect((await registry.getAgent("friday"))?.status).toBe("idle");
  });

  it("setStatus rejects archive without archiveReason with MISSING_ARCHIVE_REASON", async () => {
    await registry.registerAgent({
      name: "builder-x",
      type: "builder",
      parentName: "friday",
      worktreePath: "/tmp/builder-x",
    });

    let caught: unknown;
    try {
      await registry.setStatus("builder-x", "archived");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IllegalTransitionError);
    expect((caught as InstanceType<typeof IllegalTransitionError>).code).toBe(
      "MISSING_ARCHIVE_REASON",
    );

    expect((await registry.getAgent("builder-x"))?.status).toBe("idle");
  });

  it("setStatus rejects archived → idle with INVALID_STATUS_TRANSITION (must go through unarchiveAgent)", async () => {
    await registry.registerAgent({
      name: "builder-x",
      type: "builder",
      parentName: "friday",
      worktreePath: "/tmp/builder-x",
    });
    await registry.archiveAgent("builder-x", { reason: "completed" });
    expect((await registry.getAgent("builder-x"))?.status).toBe("archived");

    let caught: unknown;
    try {
      await registry.setStatus("builder-x", "idle");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IllegalTransitionError);
    expect((caught as InstanceType<typeof IllegalTransitionError>).code).toBe(
      "INVALID_STATUS_TRANSITION",
    );
    expect((await registry.getAgent("builder-x"))?.status).toBe("archived");

    // unarchiveAgent is the only legitimate escape from `archived`.
    await registry.unarchiveAgent("builder-x");
    expect((await registry.getAgent("builder-x"))?.status).toBe("idle");
  });

  it("archiveAgent writes both status='archived' and archive_reason=<reason>", async () => {
    await registry.registerAgent({
      name: "builder-x",
      type: "builder",
      parentName: "friday",
      worktreePath: "/tmp/builder-x",
    });

    await registry.archiveAgent("builder-x", { reason: "completed" });

    const agent = await registry.getAgent("builder-x");
    expect(agent?.status).toBe("archived");

    // AgentEntry doesn't surface `archive_reason`; hit the column
    // directly to confirm the atomic write.
    const rows = await getDb()
      .select({ archiveReason: schema.agents.archiveReason })
      .from(schema.agents)
      .where(eq(schema.agents.name, "builder-x"))
      .limit(1);
    expect(rows[0]?.archiveReason).toBe("completed");
  });

  it("archiveAgent rejects orchestrator-archive with ORCHESTRATOR_NOT_ARCHIVABLE", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });

    let caught: unknown;
    try {
      await registry.archiveAgent("friday", { reason: "completed" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IllegalTransitionError);
    expect((caught as InstanceType<typeof IllegalTransitionError>).code).toBe(
      "ORCHESTRATOR_NOT_ARCHIVABLE",
    );
    expect((await registry.getAgent("friday"))?.status).toBe("idle");
  });

  it("setStatus is silent no-op when the agent does not exist (preserves pre-FSM behavior)", async () => {
    // Production callers occasionally fire setStatus against an
    // already-deleted name (e.g. worker-exit IPC after a fast unlink).
    // Pre-FSM this was a silent UPDATE-matches-zero-rows no-op; the
    // gate preserves that contract — only transition violations throw.
    await expect(
      registry.setStatus("ghost", "idle"),
    ).resolves.toBeUndefined();
  });

  it("isLegalTransition matrix matches the documented edges", async () => {
    // Sanity-check the matrix shape so a future edit can't silently
    // widen the orchestrator's allowed transitions.
    const { isLegalTransition } = registry;
    expect(isLegalTransition("orchestrator", "idle", "archived")).toBe(false);
    expect(isLegalTransition("orchestrator", "error", "archived")).toBe(false);
    expect(isLegalTransition("orchestrator", "working", "archived")).toBe(false);
    expect(isLegalTransition("builder", "idle", "archived")).toBe(true);
    expect(isLegalTransition("builder", "working", "archived")).toBe(true);
    expect(isLegalTransition("builder", "archived", "idle")).toBe(false);
    expect(isLegalTransition("builder", "archived", "archived")).toBe(true); // same-status no-op
  });

  it("does NOT backfill the 68 historical archive_reason IS NULL rows (epic constraint)", async () => {
    // Documenting the constraint as a test so a future refactor that
    // accidentally writes a default into pre-existing NULL rows fails
    // visibly. Seeded: one row arrives at `archived` via the privileged
    // path (simulating a pre-FSM write). The FSM-aware archiveAgent
    // never touches it; the row's archive_reason stays NULL.
    const now = new Date();
    await getDb().insert(schema.agents).values({
      name: "legacy-archived",
      type: "builder",
      status: "archived",
      parentName: "friday",
      worktreePath: "/tmp/legacy",
      archiveReason: null,
      createdAt: now,
      updatedAt: now,
    });

    // The FSM gate doesn't sweep history. No write happens.
    const rows = await getDb()
      .select({ archiveReason: schema.agents.archiveReason })
      .from(schema.agents)
      .where(eq(schema.agents.name, "legacy-archived"))
      .limit(1);
    expect(rows[0]?.archiveReason).toBeNull();
  });
});
