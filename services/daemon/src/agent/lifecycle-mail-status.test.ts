import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

/**
 * Mail-triggered turn status tracking.
 *
 * When a live agent receives a `mail-wakeup` IPC the daemon wakes the worker
 * without calling sendPrompt/spawnTurn, so neither of those paths writes
 * "working" to the registry. The worker discovers mail in its own inbox,
 * calls runQuery, and emits `status-change: working` — that IPC event must
 * also mirror the transition to the DB so Zero can replicate it to the
 * dashboard (activity dot + wake lock).
 *
 * Stateful test at the right layer: the bug lived at the boundary between the
 * mail-wakeup path and the DB, so we exercise handleEvent with a registered
 * agent and assert registry.status after each IPC event.
 */

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_mail_status" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

function makeFakeWorker(agentName: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    child: { send: () => {} },
    pgid: 0,
    agentName,
    agentType: "bare",
    model: "claude-sonnet-4-6",
    turnId: `t_mail_${agentName}`,
    sessionId: `sess_${agentName}`,
    workingDirectory: `/tmp/${agentName}`,
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: undefined,
    spawnedAt: Date.now() - 1000,
    lastBlockStop: Date.now(),
    status: "idle",
    nextPrompts: [],
    mode: "long-lived",
    lastExitStatus: "complete",
    completedAtLeastOnce: true,
    blocksThisTurn: 0,
    zeroBlockTurnStreak: 0,
    ...overrides,
  };
}

describe("status-change IPC mirrors to DB for mail-triggered turns", () => {
  it("bare agent: status-change:working (mail path, no prior sendPrompt) transitions DB idle→working", async () => {
    const { handleEvent } = await import("./lifecycle.js");
    const registry = await import("./registry.js");

    await registry.registerAgent({ name: "mail-bare-1", type: "bare" });
    expect((await registry.getAgent("mail-bare-1"))?.status).toBe("idle");

    const worker = makeFakeWorker("mail-bare-1");

    // Simulate what happens when the worker wakes from mail-wakeup and
    // starts runQuery: it emits status-change:working with no prior
    // sendPrompt call from the daemon.
    await handleEvent(worker as never, { type: "status-change", status: "working" });

    expect((await registry.getAgent("mail-bare-1"))?.status).toBe("working");
  });

  it("bare agent: turn-complete after mail-triggered turn transitions DB working→idle", async () => {
    const { handleEvent } = await import("./lifecycle.js");
    const registry = await import("./registry.js");

    await registry.registerAgent({ name: "mail-bare-2", type: "bare" });
    // Seed the DB as working (simulating the state after status-change:working
    // was processed with the fix applied).
    await registry.setStatus("mail-bare-2", "working");

    const worker = makeFakeWorker("mail-bare-2", {
      status: "working",
      turnStart: Date.now() - 500,
    });

    await handleEvent(worker as never, {
      type: "turn-complete",
      sessionId: "sess_mail-bare-2",
    });

    expect((await registry.getAgent("mail-bare-2"))?.status).toBe("idle");
  });

  it("full mail-triggered turn cycle: idle→working→idle mirrors to DB", async () => {
    const { handleEvent } = await import("./lifecycle.js");
    const registry = await import("./registry.js");

    await registry.registerAgent({ name: "mail-bare-3", type: "bare" });
    expect((await registry.getAgent("mail-bare-3"))?.status).toBe("idle");

    const worker = makeFakeWorker("mail-bare-3") as { status: string; turnStart?: number };

    // Phase 1: worker wakes from mail-wakeup, starts runQuery.
    await handleEvent(worker as never, { type: "status-change", status: "working" });
    expect((await registry.getAgent("mail-bare-3"))?.status).toBe("working");

    // Phase 2: worker completes the turn.
    worker.status = "working";
    worker.turnStart = Date.now() - 500;
    await handleEvent(worker as never, {
      type: "turn-complete",
      sessionId: "sess_mail-bare-3",
    });
    expect((await registry.getAgent("mail-bare-3"))?.status).toBe("idle");
  });

  it("dispatch-initiated turn: status-change:working is idempotent when DB already shows working", async () => {
    const { handleEvent } = await import("./lifecycle.js");
    const registry = await import("./registry.js");

    await registry.registerAgent({ name: "mail-builder-1", type: "builder", parentName: "friday" });
    // sendPrompt already wrote "working" — simulate that.
    await registry.setStatus("mail-builder-1", "working");

    const worker = makeFakeWorker("mail-builder-1", {
      agentType: "builder",
      status: "working",
      turnStart: Date.now() - 100,
    });

    // Worker emits status-change:working (from runQuery), same as it does for
    // all turns. With the fix, this calls registry.setStatus("working") again.
    // working→working is a legal same-status write (no-op per FSM) so it must
    // not throw and the row must remain "working".
    await handleEvent(worker as never, { type: "status-change", status: "working" });

    expect((await registry.getAgent("mail-builder-1"))?.status).toBe("working");
  });
});
