/**
 * FRI-60: zero_block_reason tagging on turn_done.
 *
 * Tests the four scenarios:
 *   1. compactionThisTurn=true, blocksThisTurn=0, abortRequested=false  → "compaction"
 *   2. compactionThisTurn=false, blocksThisTurn=0, abortRequested=false → "sdk-resume-failure"
 *   3. abortRequested=true, blocksThisTurn=0                            → "abort"
 *   4. blocksThisTurn=1                                                  → no zero_block_reason
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_zero_block_reason" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeFakeWorker(overrides: Record<string, unknown> = {}) {
  const child = {
    send: vi.fn(),
    exitCode: null as number | null,
    killed: false,
  };
  const w = {
    child,
    pgid: 0,
    agentName: "zbr-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "turn-zbr-1",
    sessionId: "sess-zbr-1",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now(),
    spawnedAt: Date.now(),
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

interface TurnDoneEvent {
  type: string;
  zero_block_reason?: string;
  status?: string;
  turn_id?: string;
}

describe("lifecycle: zero_block_reason on turn_done (FRI-60)", () => {
  it('tags "compaction" when compactionThisTurn=true and blocksThisTurn=0', async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    const { worker } = makeFakeWorker({ agentName: "zbr-comp", turnId: "t-comp" });
    __putLiveWorkerForTest("zbr-comp", worker as never);

    const captured: TurnDoneEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as TurnDoneEvent));

    await handleEvent(
      worker as never,
      {
        type: "turn-complete",
        sessionId: "sess-zbr-1",
        compactionThisTurn: true,
      } as never,
    );
    unsub();
    __deleteLiveWorkerForTest("zbr-comp");

    const done = captured.find((e) => e.type === "turn_done");
    expect(done?.zero_block_reason).toBe("compaction");
    expect(done?.status).toBe("complete");
  });

  it('tags "sdk-resume-failure" when no compaction and blocksThisTurn=0', async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    const { worker } = makeFakeWorker({ agentName: "zbr-sdk", turnId: "t-sdk" });
    __putLiveWorkerForTest("zbr-sdk", worker as never);

    const captured: TurnDoneEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as TurnDoneEvent));

    await handleEvent(
      worker as never,
      {
        type: "turn-complete",
        sessionId: "sess-zbr-1",
        compactionThisTurn: false,
      } as never,
    );
    unsub();
    __deleteLiveWorkerForTest("zbr-sdk");

    const done = captured.find((e) => e.type === "turn_done");
    expect(done?.zero_block_reason).toBe("sdk-resume-failure");
  });

  it('tags "abort" when abortRequested=true and blocksThisTurn=0', async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    const { worker } = makeFakeWorker({
      agentName: "zbr-abort",
      turnId: "t-abort",
      abortRequested: true,
    });
    __putLiveWorkerForTest("zbr-abort", worker as never);

    const captured: TurnDoneEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as TurnDoneEvent));

    await handleEvent(
      worker as never,
      {
        type: "turn-complete",
        sessionId: "sess-zbr-1",
        compactionThisTurn: true,
      } as never,
    );
    unsub();
    __deleteLiveWorkerForTest("zbr-abort");

    const done = captured.find((e) => e.type === "turn_done");
    // abort_requested wins over compaction
    expect(done?.zero_block_reason).toBe("abort");
    expect(done?.status).toBe("aborted");
  });

  it("omits zero_block_reason when blocksThisTurn > 0", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    const { worker } = makeFakeWorker({
      agentName: "zbr-normal",
      turnId: "t-normal",
      blocksThisTurn: 1,
    });
    __putLiveWorkerForTest("zbr-normal", worker as never);

    const captured: TurnDoneEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as TurnDoneEvent));

    await handleEvent(
      worker as never,
      {
        type: "turn-complete",
        sessionId: "sess-zbr-1",
        compactionThisTurn: false,
      } as never,
    );
    unsub();
    __deleteLiveWorkerForTest("zbr-normal");

    const done = captured.find((e) => e.type === "turn_done");
    expect(done).toBeDefined();
    expect(done?.zero_block_reason).toBeUndefined();
  });
});
