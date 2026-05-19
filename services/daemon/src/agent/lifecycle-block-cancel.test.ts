import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

// FRI-78 follow-up: the worker emits `block-cancel` (instead of `block-stop`)
// for blocks that started but accumulated zero content — the canonical case
// being an SDK-opened `thinking` block at a pending-injection break, which
// pre-fix leaked into the DB as an empty `aborted` row and rendered as a
// misleading "Thinking STOPPED" footer in the dashboard. The daemon's
// handler DELETEs the row and publishes a `block_canceled` SSE so live
// clients drop the bubble.

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "block_cancel" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  const liveTurns = await import("./live-turns.js");
  liveTurns.__resetForTest();
});

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

function makeFakeWorker(): unknown {
  return {
    child: { send: () => {} },
    pgid: 0,
    agentName: "cancel-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "turn-cancel-1",
    sessionId: "sess-cancel-1",
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
  };
}

describe("handleBlockCancel (FRI-78 follow-up)", () => {
  it("block-cancel deletes the row and publishes block_canceled SSE", async () => {
    const { handleEvent } = await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");
    const { getBlockById } = await import("@friday/shared/services");

    const captured: Array<{
      type?: string;
      block_id?: string;
      turn_id?: string;
      agent?: string;
      seq?: number;
    }> = [];
    const unsub = eventBus.subscribe((e) =>
      captured.push(
        e as {
          type?: string;
          block_id?: string;
          turn_id?: string;
          agent?: string;
          seq?: number;
        },
      ),
    );

    const w = makeFakeWorker();

    handleEvent(w as never, {
      type: "block-start",
      clientBlockId: "c-thinking-empty",
      kind: "thinking",
      blockIndex: 0,
      messageId: "msg-cancel-1",
    } as never);
    // handleBlockStart writes via fire-and-forget; let the row land.
    await settle();

    const startEvt = captured.find(
      (e) =>
        e.type === "block_start" &&
        e.turn_id === "turn-cancel-1" &&
        e.agent === "cancel-agent",
    );
    expect(startEvt).toBeDefined();
    const blockId = startEvt!.block_id!;
    expect(blockId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getBlockById(blockId)).not.toBeNull();

    handleEvent(w as never, {
      type: "block-cancel",
      clientBlockId: "c-thinking-empty",
    } as never);
    await settle();

    unsub();

    expect(await getBlockById(blockId)).toBeNull();
    const cancelEvt = captured.find(
      (e) => e.type === "block_canceled" && e.block_id === blockId,
    );
    expect(cancelEvt).toBeDefined();
    expect(cancelEvt!.turn_id).toBe("turn-cancel-1");
    expect(cancelEvt!.agent).toBe("cancel-agent");
    expect(typeof cancelEvt!.seq).toBe("number");
    expect(cancelEvt!.seq!).toBeGreaterThan(startEvt!.seq!);
  });

  it("stale block-cancel for an unknown clientBlockId is a no-op (no SSE, no throw)", async () => {
    const { handleEvent } = await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    const captured: Array<{ type?: string; block_id?: string }> = [];
    const unsub = eventBus.subscribe((e) =>
      captured.push(e as { type?: string; block_id?: string }),
    );

    const w = makeFakeWorker();

    expect(() => {
      handleEvent(w as never, {
        type: "block-cancel",
        clientBlockId: "c-unknown",
      } as never);
    }).not.toThrow();
    await settle();

    unsub();

    expect(
      captured.find((e) => e.type === "block_canceled"),
    ).toBeUndefined();
  });
});
