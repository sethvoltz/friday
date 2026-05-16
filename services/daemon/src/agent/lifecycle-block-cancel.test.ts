import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// FRI-78 follow-up: the worker emits `block-cancel` (instead of `block-stop`)
// for blocks that started but accumulated zero content — the canonical case
// being an SDK-opened `thinking` block at a pending-injection break, which
// pre-fix leaked into the DB as an empty `aborted` row and rendered as a
// misleading "Thinking STOPPED" footer in the dashboard. The daemon's
// handler DELETEs the row and publishes a `block_canceled` SSE so live
// clients drop the bubble.

const dataDir = mkdtempSync(join(tmpdir(), "friday-block-cancel-"));
process.env.FRIDAY_DATA_DIR = dataDir;

beforeAll(async () => {
  const { runMigrations } = await import("@friday/shared");
  runMigrations();
});

afterAll(async () => {
  const { closeDb } = await import("@friday/shared");
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { getRawDb } = await import("@friday/shared");
  getRawDb().prepare("DELETE FROM blocks").run();
  const liveTurns = await import("./live-turns.js");
  liveTurns.__resetForTest();
});

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

    // Mirror the SDK opening a `thinking` content block: block-start IPC
    // fires, daemon inserts a streaming row + registers the block in
    // liveTurns. clientBlockId is the worker's local handle; blockId is
    // the daemon-minted UUID we expect on the cancel SSE.
    handleEvent(w as never, {
      type: "block-start",
      clientBlockId: "c-thinking-empty",
      kind: "thinking",
      blockIndex: 0,
      messageId: "msg-cancel-1",
    } as never);

    // The daemon's handleBlockStart picked a UUID for blockId. Grab it
    // off the published block_start event so we can assert the row was
    // really written and then deleted.
    const startEvt = captured.find(
      (e) =>
        e.type === "block_start" &&
        e.turn_id === "turn-cancel-1" &&
        e.agent === "cancel-agent",
    );
    expect(startEvt).toBeDefined();
    const blockId = startEvt!.block_id!;
    expect(blockId).toMatch(/^[0-9a-f-]{36}$/);
    expect(getBlockById(blockId)).not.toBeNull();

    // No deltas accumulated. Now the worker exited the for-await loop
    // (pending-injection break) and emitted block-cancel for this empty
    // block. The daemon should DELETE the row and publish block_canceled.
    handleEvent(w as never, {
      type: "block-cancel",
      clientBlockId: "c-thinking-empty",
    } as never);

    unsub();

    expect(getBlockById(blockId)).toBeNull();
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

    // No prior block-start for this clientBlockId — mirrors a stale
    // IPC arriving after liveTurns.dropTurn already ran (e.g. the worker
    // raced a force-kill). handleBlockCancel must bail cleanly.
    expect(() => {
      handleEvent(w as never, {
        type: "block-cancel",
        clientBlockId: "c-unknown",
      } as never);
    }).not.toThrow();

    unsub();

    expect(
      captured.find((e) => e.type === "block_canceled"),
    ).toBeUndefined();
  });
});
