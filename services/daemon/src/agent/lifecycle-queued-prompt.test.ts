import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Pending-message feature: a second POST /api/chat/turn while the worker
// is mid-turn lands as status='queued' in the blocks table and parks in
// the worker's `nextPrompts` FIFO. When the drain path eventually fires
// the queued prompt, the row flips to status='complete' with a fresh ts
// and a `block_meta_update` SSE event tells the dashboard to unpin the
// bubble and re-sort it inline.

const dataDir = mkdtempSync(join(tmpdir(), "friday-lifecycle-queued-"));
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
  getRawDb().prepare("DELETE FROM agents").run();
  vi.useRealTimers();
});

interface CapturedEvent {
  type: string;
  turn_id?: string;
  agent?: string;
  status?: string;
  block_id?: string;
  ts?: number;
  role?: string;
  kind?: string;
}

interface FakeChild {
  send: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  killed: boolean;
}

function makeFakeWorker(overrides: Record<string, unknown> = {}): {
  worker: unknown;
  child: FakeChild;
} {
  const child: FakeChild = { send: vi.fn(), exitCode: null, killed: false };
  const w = {
    child,
    // pgid 0 makes killPgrp a no-op — we never want the test to SIGTERM
    // a real process.
    pgid: 0,
    agentName: "queued-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "t_existing",
    sessionId: "sess-1",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now() - 1_000,
    spawnedAt: Date.now() - 5_000,
    lastBlockStop: Date.now(),
    status: "working",
    nextPrompts: [],
    mode: "long-lived",
    lastExitStatus: "complete",
    completedAtLeastOnce: false,
    ...overrides,
  };
  return { worker: w, child };
}

describe("lifecycle: queued user-block dispatch", () => {
  it("recordUserBlock(status='queued') persists status='queued' on the row", async () => {
    const { recordUserBlock } = await import("./lifecycle.js");
    const { getRawDb } = await import("@friday/shared");

    const { blockId } = recordUserBlock({
      turnId: "t_q1",
      agentName: "queued-agent",
      sessionId: "sess-1",
      text: "follow up while busy",
      source: "user_chat",
      status: "queued",
    });

    const row = getRawDb()
      .prepare("SELECT status, role, source, content_json FROM blocks WHERE block_id = ?")
      .get(blockId) as
      | {
          status: string;
          role: string;
          source: string;
          content_json: string;
        }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("queued");
    expect(row!.role).toBe("user");
    expect(row!.source).toBe("user_chat");
    const parsed = JSON.parse(row!.content_json) as { text: string };
    expect(parsed.text).toBe("follow up while busy");
  });

  it("emits block_complete with status='queued' on SSE (so the dashboard pins it)", async () => {
    const { recordUserBlock } = await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    recordUserBlock({
      turnId: "t_q2",
      agentName: "queued-agent",
      sessionId: "sess-1",
      text: "another queued",
      source: "user_chat",
      status: "queued",
    });
    unsub();

    const event = captured.find(
      (e) =>
        e.type === "block_complete" &&
        e.turn_id === "t_q2" &&
        e.role === "user",
    );
    expect(event).toBeDefined();
    expect(event!.status).toBe("queued");
  });

  it("recordUserBlock(status='complete') for user_chat does NOT emit SSE (legacy race-protection)", async () => {
    const { recordUserBlock } = await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    recordUserBlock({
      turnId: "t_immediate",
      agentName: "queued-agent",
      sessionId: "sess-1",
      text: "fires immediately",
      source: "user_chat",
      // status defaults to 'complete'
    });
    unsub();

    const blockCompletes = captured.filter(
      (e) => e.type === "block_complete" && e.turn_id === "t_immediate",
    );
    // Optimistic-bubble race protection: user_chat at 'complete' skips SSE.
    expect(blockCompletes).toHaveLength(0);
  });

  it("dispatchTurn queues a second prompt for a working worker and signals prompts-pending", async () => {
    const {
      dispatchTurn,
      __putLiveWorkerForTest,
      __deleteLiveWorkerForTest,
    } = await import("./lifecycle.js");

    const { worker, child } = makeFakeWorker();
    __putLiveWorkerForTest("queued-agent", worker as never);

    dispatchTurn({
      agentName: "queued-agent",
      options: {
        agentName: "queued-agent",
        agentType: "orchestrator",
        workingDirectory: "/tmp/fake",
        systemPrompt: "sys",
        prompt: "queued prompt",
        turnId: "t_q3",
        model: "claude-opus-4-7",
        daemonPort: 8765,
        mode: "long-lived",
      },
      userBlockId: "block-q3",
    });

    // The worker is "working" — the prompt should land in nextPrompts.
    const w = worker as { nextPrompts: Array<{ turnId: string; userBlockId?: string }> };
    expect(w.nextPrompts).toHaveLength(1);
    expect(w.nextPrompts[0].turnId).toBe("t_q3");
    expect(w.nextPrompts[0].userBlockId).toBe("block-q3");
    // ...and the worker is nudged to break at next iteration boundary.
    expect(child.send).toHaveBeenCalledWith({ type: "prompts-pending" });

    __deleteLiveWorkerForTest("queued-agent");
  });

  it("removeQueuedPrompt yanks an entry out of nextPrompts and returns it", async () => {
    const {
      dispatchTurn,
      removeQueuedPrompt,
      __putLiveWorkerForTest,
      __deleteLiveWorkerForTest,
    } = await import("./lifecycle.js");

    const { worker } = makeFakeWorker();
    __putLiveWorkerForTest("queued-agent", worker as never);
    dispatchTurn({
      agentName: "queued-agent",
      options: {
        agentName: "queued-agent",
        agentType: "orchestrator",
        workingDirectory: "/tmp/fake",
        systemPrompt: "sys",
        prompt: "to-cancel",
        turnId: "t_cancel",
        model: "claude-opus-4-7",
        daemonPort: 8765,
        mode: "long-lived",
      },
      userBlockId: "block-cancel",
    });

    const w = worker as { nextPrompts: unknown[] };
    expect(w.nextPrompts).toHaveLength(1);

    const removed = removeQueuedPrompt("queued-agent", "t_cancel");
    expect(removed?.turnId).toBe("t_cancel");
    expect(removed?.prompt).toBe("to-cancel");
    expect(w.nextPrompts).toHaveLength(0);

    // No live worker → null, no throw.
    expect(removeQueuedPrompt("nonexistent", "t_xxx")).toBeNull();

    __deleteLiveWorkerForTest("queued-agent");
  });

  it("queued → drained: block_meta_update flips status + bumps ts, the DB row tracks", async () => {
    // Stand up a real queued user block, then drive the queue-drain path
    // (turn-complete) and assert: SSE meta-update fires with complete +
    // new ts, the row in `blocks` matches, and the new ts strictly
    // beats the original POST ts. Test seam writes a fake LiveWorker
    // with a single queued WorkerPromptCommand carrying its userBlockId.
    const { recordUserBlock, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");
    const { getRawDb } = await import("@friday/shared");

    const { blockId, seq: originalSeq } = recordUserBlock({
      turnId: "t_drain",
      agentName: "queued-agent",
      sessionId: "sess-1",
      text: "I waited my turn",
      source: "user_chat",
      status: "queued",
    });
    expect(originalSeq).toBeGreaterThan(0); // queued emits SSE
    const beforeRow = getRawDb()
      .prepare("SELECT status, ts FROM blocks WHERE block_id = ?")
      .get(blockId) as { status: string; ts: number };
    expect(beforeRow.status).toBe("queued");

    const { worker, child } = makeFakeWorker({
      // Pretend a queued prompt is parked behind the in-flight turn.
      nextPrompts: [
        {
          prompt: "I waited my turn",
          turnId: "t_drain",
          userBlockId: blockId,
        },
      ],
    });
    __putLiveWorkerForTest("queued-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    // Sleep so the drain timestamp is strictly newer than the row's ts.
    await new Promise((r) => setTimeout(r, 10));

    // Drive turn-complete on the live worker. The handler drains
    // nextPrompts → sendPrompt → restampQueuedUserBlock fires.
    const { handleEvent } = await import("./lifecycle.js");
    handleEvent(worker as never, {
      type: "turn-complete",
      sessionId: "sess-1",
      usage: undefined,
    } as never);

    unsub();
    __deleteLiveWorkerForTest("queued-agent");

    const meta = captured.find(
      (e) =>
        e.type === "block_meta_update" &&
        e.block_id === blockId &&
        e.status === "complete",
    );
    expect(meta).toBeDefined();
    expect(typeof meta!.ts).toBe("number");
    expect(meta!.ts!).toBeGreaterThan(beforeRow.ts);

    const afterRow = getRawDb()
      .prepare("SELECT status, ts FROM blocks WHERE block_id = ?")
      .get(blockId) as { status: string; ts: number };
    expect(afterRow.status).toBe("complete");
    expect(afterRow.ts).toBe(meta!.ts);
    // The queued IPC ran too: the worker received `prompt` after the drain.
    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "prompt" }),
    );
  });

  it("listQueuedUserBlocks returns queued rows in ts order (oldest first)", async () => {
    const { recordUserBlock } = await import("./lifecycle.js");
    const { listQueuedUserBlocks } = await import("@friday/shared/services");

    const before = Date.now();
    const { blockId: b1 } = recordUserBlock({
      turnId: "t_old",
      agentName: "queued-agent",
      sessionId: "sess-1",
      text: "older",
      source: "user_chat",
      status: "queued",
    });
    // Bump time a hair so the ts strictly differs even on fast machines.
    await new Promise((r) => setTimeout(r, 5));
    const { blockId: b2 } = recordUserBlock({
      turnId: "t_new",
      agentName: "queued-agent",
      sessionId: "sess-1",
      text: "newer",
      source: "user_chat",
      status: "queued",
    });
    // A complete row should NOT show up in the queued list.
    recordUserBlock({
      turnId: "t_done",
      agentName: "queued-agent",
      sessionId: "sess-1",
      text: "already complete",
      source: "user_chat",
      status: "complete",
    });

    const rows = listQueuedUserBlocks();
    const ours = rows.filter((r) => r.agentName === "queued-agent");
    expect(ours.map((r) => r.blockId)).toEqual([b1, b2]);
    expect(ours[0].ts).toBeGreaterThanOrEqual(before);
    expect(ours[1].ts).toBeGreaterThanOrEqual(ours[0].ts);
  });
});
