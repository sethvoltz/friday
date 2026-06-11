/**
 * F17: the orchestrator agent must be seeded on daemon boot.
 *
 * Without it, a fresh install has no `agents` row for the orchestrator until the
 * first dispatched message — so the dashboard's always-present orchestrator chat
 * 404s on GET /api/agents/<name> (→ 502 through the proxy) and hangs on the
 * loading skeleton. `ensureOrchestratorAgent` is insert-only: it creates the row
 * when missing and NEVER touches an existing orchestrator's status/session.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;
let registry: typeof import("./registry.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "orchestrator_seed" });
  registry = await import("./registry.js");
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

describe("ensureOrchestratorAgent (F17 boot seed)", () => {
  it("creates the orchestrator row when missing", async () => {
    expect(await registry.getAgent("friday")).toBeNull();

    await registry.ensureOrchestratorAgent("friday");

    const a = await registry.getAgent("friday");
    expect(a).toMatchObject({ name: "friday", type: "orchestrator", status: "idle" });
  });

  it("is idempotent — a second call leaves exactly one orchestrator row", async () => {
    await registry.ensureOrchestratorAgent("friday");
    await registry.ensureOrchestratorAgent("friday");

    const rows = await getDb().select().from(schema.agents).where(eq(schema.agents.name, "friday"));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("orchestrator");
  });

  it("is insert-only — never resets an existing orchestrator's live status", async () => {
    await registry.ensureOrchestratorAgent("friday");
    // Simulate a live orchestrator mid-work (direct write bypasses the FSM door
    // to set up the precondition this test cares about).
    await getDb()
      .update(schema.agents)
      .set({ status: "working" })
      .where(eq(schema.agents.name, "friday"));

    // Boot seed runs again (daemon restart while the orchestrator was working).
    await registry.ensureOrchestratorAgent("friday");

    const a = await registry.getAgent("friday");
    // Must NOT have been clobbered back to idle — that would mask a live turn on
    // a prod restart. This is the guard against using a bare registerAgent here.
    expect(a?.status).toBe("working");
  });
});
