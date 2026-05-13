/**
 * PR A / F1-A: when a worker exits, the exit handler must preserve
 * terminal statuses (`archived`, `error`) instead of unconditionally
 * resetting to `idle`. The race we are pinning:
 *
 *   1. archiveAgent(name) → registry.archiveAgent(name) → status="archived"
 *   2. worker process exits
 *   3. (old bug) child.on("exit") → registry.setStatus(name, "idle")
 *      overwrites the terminal status → next workspace-cleanup 409s
 *
 * Drives the registry directly (no real worker) and inspects the rows.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataRoot = mkdtempSync(join(tmpdir(), "friday-archive-race-"));
process.env.FRIDAY_DATA_DIR = dataRoot;

const { runMigrations, closeDb } = await import("@friday/shared");
const registry = await import("./registry.js");

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  closeDb();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("F1-A: archive race", () => {
  it("archiveAgent marks status=archived synchronously", () => {
    registry.registerAgent({
      name: "alpha",
      type: "bare",
    });
    registry.setStatus("alpha", "working");

    registry.archiveAgent("alpha");

    const a = registry.getAgent("alpha");
    expect(a?.status).toBe("archived");
  });

  it("terminal `archived` status is not overwritten by a subsequent setStatus(idle) check", () => {
    // The bug was that the worker's `exit` handler called setStatus("idle")
    // unconditionally. The fix in lifecycle.ts wraps the setStatus in a
    // status check. The check itself lives in lifecycle.ts; here we
    // simulate it the same way the exit handler does and pin the expected
    // behaviour at the registry layer.
    registry.registerAgent({ name: "beta", type: "bare" });
    registry.archiveAgent("beta"); // → archived
    const cur = registry.getAgent("beta");
    // Emulates the F1-A guard.
    if (cur && cur.status !== "archived" && cur.status !== "error") {
      registry.setStatus("beta", "idle");
    }
    expect(registry.getAgent("beta")?.status).toBe("archived");
  });

  it("terminal `error` status is also preserved", () => {
    registry.registerAgent({ name: "gamma", type: "bare" });
    registry.setStatus("gamma", "error");
    const cur = registry.getAgent("gamma");
    if (cur && cur.status !== "archived" && cur.status !== "error") {
      registry.setStatus("gamma", "idle");
    }
    expect(registry.getAgent("gamma")?.status).toBe("error");
  });

  it("non-terminal `working` status DOES flip to idle on the same guard", () => {
    // Regression check: the guard only suppresses idle-reset for terminal
    // states. A live worker that legitimately went idle still gets the
    // reset (the guard isn't a blanket no-op).
    registry.registerAgent({ name: "delta", type: "bare" });
    registry.setStatus("delta", "working");
    const cur = registry.getAgent("delta");
    if (cur && cur.status !== "archived" && cur.status !== "error") {
      registry.setStatus("delta", "idle");
    }
    expect(registry.getAgent("delta")?.status).toBe("idle");
  });
});
