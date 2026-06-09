/**
 * Durable compaction-in-progress flag: `agents.compacting_since`.
 *
 * `setCompactingSince` is the PRIMARY writer (called from the lifecycle's
 * `compacting-status` handler on the SDK's start/done frames).
 * `_setStatusUnchecked` clears the flag as a BACKSTOP whenever an agent leaves
 * `working`, and `clearStaleCompacting` sweeps orphaned values on BOOT.
 * Together they guarantee a worker that dies mid-compaction — emitting no
 * `done` frame — can't wedge the dashboard's "Compacting context…" indicator
 * on, since the indicator reconstructs from this column.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;
let registry: typeof import("./registry.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "registry_compacting" });
  registry = await import("./registry.js");
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

async function compactingSinceOf(name: string): Promise<Date | null> {
  const [row] = await getDb().select().from(schema.agents).where(eq(schema.agents.name, name));
  return row?.compactingSince ?? null;
}

describe("registry.setCompactingSince (primary writer)", () => {
  it("sets a timestamp, then clears it to NULL", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    const t = new Date();

    await registry.setCompactingSince("friday", t);
    expect((await compactingSinceOf("friday"))?.getTime()).toBe(t.getTime());

    await registry.setCompactingSince("friday", null);
    expect(await compactingSinceOf("friday")).toBeNull();
  });
});

describe("compacting_since backstop on status transitions", () => {
  it("clears compacting_since when the agent leaves `working` (→ idle)", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    await registry.setStatus("friday", "working");
    await registry.setCompactingSince("friday", new Date());
    expect(await compactingSinceOf("friday")).not.toBeNull();

    // The turn-end idle projection routes through _setStatusUnchecked, which
    // nulls the flag atomically — even if no `done` frame ever arrived.
    await registry.setStatus("friday", "idle");
    expect(await compactingSinceOf("friday")).toBeNull();
  });

  it("does NOT clear compacting_since when the target status is `working` (no mid-compaction race)", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    await registry.setStatus("friday", "working");
    const t = new Date();
    await registry.setCompactingSince("friday", t);

    // A redundant working→working projection must not wipe an in-flight flag.
    await registry.setStatus("friday", "working");
    expect((await compactingSinceOf("friday"))?.getTime()).toBe(t.getTime());
  });
});

describe("registry.clearStaleCompacting (boot reconcile)", () => {
  it("nulls every set flag and returns the cleared count", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    await registry.registerAgent({ name: "agent-b", type: "orchestrator" });
    await registry.registerAgent({ name: "agent-c", type: "orchestrator" });
    await registry.setCompactingSince("friday", new Date());
    await registry.setCompactingSince("agent-b", new Date());

    const cleared = await registry.clearStaleCompacting();
    expect(cleared).toBe(2);
    expect(await compactingSinceOf("friday")).toBeNull();
    expect(await compactingSinceOf("agent-b")).toBeNull();
    // The agent that never had a flag is untouched and not counted.
    expect(await compactingSinceOf("agent-c")).toBeNull();
  });

  it("returns 0 when no agent is flagged", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    expect(await registry.clearStaleCompacting()).toBe(0);
  });
});
