/**
 * PR A / F1-A: when a worker exits, the exit handler must preserve the
 * terminal `archived` status instead of unconditionally resetting to
 * `idle`. The race we are pinning:
 *
 *   1. archiveAgent(name) → registry.archiveAgent(name) → status="archived"
 *   2. worker process exits
 *   3. (old bug) child.on("exit") → registry.setStatus(name, "idle")
 *      overwrites the terminal status → next workspace-cleanup 409s
 *
 * Drives the registry directly (no real worker) and inspects the rows.
 *
 * FRI-145 M5: the agent-status error value was pruned (the hard-exit self-heal
 * now projects idle, not a sticky terminal), so the old terminal-preservation
 * case for that value is gone — it is no longer a legal status to transition to.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;
let registry: typeof import("./registry.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "archive_race" });
  registry = await import("./registry.js");
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

describe("F1-A: archive race", () => {
  it("archiveAgent marks status=archived synchronously", async () => {
    await registry.registerAgent({
      name: "alpha",
      type: "bare",
    });
    await registry.setStatus("alpha", "working");

    await registry.archiveAgent("alpha", { reason: "abandoned" });

    const a = await registry.getAgent("alpha");
    expect(a?.status).toBe("archived");
  });

  it("terminal `archived` status is not overwritten by a subsequent setStatus(idle) check", async () => {
    // The bug was that the worker's `exit` handler called setStatus("idle")
    // unconditionally. The fix in lifecycle.ts wraps the setStatus in a
    // status check. The check itself lives in lifecycle.ts; here we
    // simulate it the same way the exit handler does and pin the expected
    // behaviour at the registry layer.
    await registry.registerAgent({ name: "beta", type: "bare" });
    await registry.archiveAgent("beta", { reason: "abandoned" }); // → archived
    const cur = await registry.getAgent("beta");
    // Emulates the F1-A guard.
    if (cur && cur.status !== "archived") {
      await registry.setStatus("beta", "idle");
    }
    expect((await registry.getAgent("beta"))?.status).toBe("archived");
  });

  it("non-terminal `working` status DOES flip to idle on the same guard", async () => {
    // Regression check: the guard only suppresses idle-reset for the terminal
    // `archived` state. A live worker that legitimately went idle still gets
    // the reset (the guard isn't a blanket no-op).
    await registry.registerAgent({ name: "delta", type: "bare" });
    await registry.setStatus("delta", "working");
    const cur = await registry.getAgent("delta");
    if (cur && cur.status !== "archived") {
      await registry.setStatus("delta", "idle");
    }
    expect((await registry.getAgent("delta"))?.status).toBe("idle");
  });
});
