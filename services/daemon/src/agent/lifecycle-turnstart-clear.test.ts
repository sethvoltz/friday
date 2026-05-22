/**
 * FRI-110 + FRI-116: `w.turnStart = undefined` is the post-condition of
 * every turn-end exit. The lifecycle handler has FIVE such exits:
 *
 *   1. happy `turn-complete` (lifecycle.ts ~line 1631 — happy-path clear)
 *   2. `error` event (lifecycle.ts ~line 1502 — happy-path clear)
 *   3. wedge force-kill via `turn-complete` (lifecycle.ts ~line 1597 — hoisted clear)
 *   4. wedge force-kill via `error` (lifecycle.ts ~line 1473 — hoisted clear)
 *   5. `forceKillStuckWorker` itself (lifecycle.ts ~line 879)
 *
 * Original FRI-110 fix relied on (5)'s clear to cover (3) and (4) — a
 * "trust the chain" pattern. FRI-116 hoists the clear into the wedge
 * branches themselves so each branch holds its own invariant locally.
 *
 * This file pins the post-condition end-to-end. The wedge tests
 * deliberately do NOT register the worker in the live map, so that the
 * `forceKillStuckWorker(...)` call inside the wedge branch is a no-op
 * (it short-circuits on `!live.has(w.agentName)`). That isolates the
 * assertion to the hoisted clear — if the hoist is reverted, these
 * tests fail.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_turnstart_clear" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface FakeChild {
  send: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  killed: boolean;
}

function makeFakeWorker(overrides: Record<string, unknown> = {}): {
  worker: { turnStart: number | undefined } & Record<string, unknown>;
  child: FakeChild;
} {
  const child: FakeChild = {
    send: vi.fn(),
    exitCode: null,
    killed: false,
  };
  const w = {
    child,
    pgid: 0,
    agentName: "ts-clear-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "turn-ts-1",
    sessionId: "sess-ts-1",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now() - 1000,
    spawnedAt: Date.now() - 5000,
    lastBlockStop: Date.now(),
    status: "working",
    nextPrompts: [],
    mode: "long-lived",
    lastExitStatus: "complete",
    completedAtLeastOnce: false,
    blocksThisTurn: 0,
    zeroBlockTurnStreak: 0,
    ...overrides,
  };
  return { worker: w, child };
}

describe("lifecycle: w.turnStart cleared on every turn-end path (FRI-110, FRI-116)", () => {
  it("happy turn-complete clears w.turnStart", async () => {
    const { handleEvent } = await import("./lifecycle.js");
    const { worker } = makeFakeWorker({
      blocksThisTurn: 1, // produced a block → not wedge
      zeroBlockTurnStreak: 0,
    });
    await handleEvent(
      worker as never,
      {
        type: "turn-complete",
        sessionId: "sess-ts-1",
      } as never,
    );
    expect(worker.turnStart).toBeUndefined();
  });

  it("error event clears w.turnStart", async () => {
    const { handleEvent } = await import("./lifecycle.js");
    const { worker } = makeFakeWorker({
      blocksThisTurn: 1,
      zeroBlockTurnStreak: 0,
    });
    await handleEvent(
      worker as never,
      {
        type: "error",
        message: "SDK error",
        recoverable: true,
        code: "test_error",
        headline: "test error",
        rawMessage: "test",
      } as never,
    );
    expect(worker.turnStart).toBeUndefined();
  });

  it("wedge force-kill via turn-complete clears w.turnStart (hoisted clear)", async () => {
    // The hoist puts `w.turnStart = undefined` BEFORE the
    // `forceKillStuckWorker(...)` call. We don't put the worker into the
    // live map, so `forceKillStuckWorker` short-circuits on
    // `!live.has(w.agentName)` and does nothing destructive — but the
    // hoisted clear runs unconditionally before that call. If the hoist
    // is reverted, w.turnStart remains set and this test fails.
    const { handleEvent } = await import("./lifecycle.js");
    const { worker } = makeFakeWorker({
      blocksThisTurn: 0,
      zeroBlockTurnStreak: 9, // one more zero-block turn trips the default threshold of 10
    });
    await handleEvent(
      worker as never,
      {
        type: "turn-complete",
        sessionId: "sess-ts-1",
      } as never,
    );
    expect(worker.turnStart).toBeUndefined();
  });

  it("wedge force-kill via error clears w.turnStart (hoisted clear)", async () => {
    // Symmetric to the turn-complete case; the error case has its own
    // independent wedge branch in lifecycle.ts. Both must hoist.
    const { handleEvent } = await import("./lifecycle.js");
    const { worker } = makeFakeWorker({
      blocksThisTurn: 0,
      zeroBlockTurnStreak: 9,
    });
    await handleEvent(
      worker as never,
      {
        type: "error",
        message: "SDK error",
        recoverable: true,
        code: "wedge_error",
        headline: "wedge error",
        rawMessage: "test",
      } as never,
    );
    expect(worker.turnStart).toBeUndefined();
  });

  it("force-kill via stale-turn ceiling clears w.turnStart", async () => {
    // The stale-turn reaper (handleEvent prologue, ~line 1304) calls
    // forceKillStuckWorker directly. With the worker not in the live
    // map, forceKillStuckWorker's `!live.has` short-circuit fires —
    // BUT the call returns before reaching its own clear at line 879,
    // so this test exercises the prologue's reliance on the
    // function's behavior. To distinguish: forceKillStuckWorker is
    // idempotent on `w.forceKilled` AND short-circuits when not in
    // live map. Either way, w.turnStart's clearing is its
    // responsibility. We confirm post-condition by registering the
    // worker, then driving the prologue.
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { worker } = makeFakeWorker({
      // Push turnStart far enough in the past to trip the 4h
      // FRIDAY_TURN_STALE_CEILING_MS default. ~5h ago.
      turnStart: Date.now() - 5 * 60 * 60 * 1000,
      blocksThisTurn: 1,
      zeroBlockTurnStreak: 0,
    });
    __putLiveWorkerForTest("ts-clear-agent", worker as never);
    try {
      await handleEvent(
        worker as never,
        {
          type: "heartbeat",
        } as never,
      );
      expect(worker.turnStart).toBeUndefined();
    } finally {
      __deleteLiveWorkerForTest("ts-clear-agent");
    }
  });
});
