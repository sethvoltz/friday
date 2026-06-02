/**
 * FRI-145 M5 — hard-exit self-heal (AC #9). Bug #2.
 *
 * A worker process exits with a turn still in flight and NO terminal
 * turn-complete/error ever processed (SIGTERM from the stall watchdog, SIGKILL,
 * OOM, crash). The OLD exit handler finalized streaming blocks and reset the row
 * to `idle` but NEVER published `turn_done`, so the dashboard's inflight turn
 * pin stayed up forever even though the agent was dispatchable.
 *
 * M5 routes the exit self-heal through the Turn-state machine's `hard-exit`
 * Transition, which now:
 *   - finalizes any streaming blocks as `error`,
 *   - publishes the canonical in-band `error` event, then
 *   - publishes the MISSING `turn_done{status:"error"}` for the dead turn_id,
 *   - and heals the row to `idle` (dispatchable; no sticky dead state).
 *
 * Layer-correct + stateful: drives the REAL `finalizeHardExit` control flow
 * against the real live map + a real test Postgres. The block rows flip on the
 * real `block-stream` pipeline; the row projection is read off the actual
 * `agents` row; `eventBus.publish` is spied to capture the wire events. Nothing
 * under test is mocked.
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;
let lifecycle: typeof import("./lifecycle.js");
let registry: typeof import("./registry.js");
let blockStream: typeof import("./block-stream.js");
let bus: typeof import("../events/bus.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_hard_exit" });
  lifecycle = await import("./lifecycle.js");
  registry = await import("./registry.js");
  blockStream = await import("./block-stream.js");
  bus = await import("../events/bus.js");
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  vi.restoreAllMocks();
  blockStream.__resetForTest();
});

afterEach(() => {
  for (const name of lifecycle.liveAgentNames()) {
    lifecycle.__deleteLiveWorkerForTest(name);
  }
});

interface FakeChild {
  send: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  killed: boolean;
  pid?: number;
}

function makeFakeWorker(overrides: Record<string, unknown> = {}): unknown {
  const child: FakeChild = { send: vi.fn(), exitCode: 1, killed: true, pid: 0 };
  return {
    child,
    pgid: 0,
    agentName: "dead-agent",
    agentType: "builder",
    model: "claude-opus-4-7",
    turnId: "turn-dead-1",
    sessionId: "sess-dead-1",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now(), // a turn WAS in flight (no terminal event)
    spawnedAt: Date.now(),
    lastBlockStop: Date.now(),
    status: "working",
    nextPrompts: [],
    mode: "long-lived",
    lastExitStatus: "complete",
    completedAtLeastOnce: false,
    blocksThisTurn: 1,
    zeroBlockTurnStreak: 0,
    mailSendToParentThisTurn: 0,
    noMailBackNudgedThisTurn: false,
    noMailBackStreak: 0,
    ...overrides,
  };
}

/** Seed a streaming tool_use block + its in-flight block-stream entry so the
 *  hard-exit finalize has something to flip off `streaming`. */
async function seedStreamingBlock(turnId: string, agent: string, session: string): Promise<void> {
  const { insertBlock } = await import("@friday/shared/services");
  await insertBlock({
    blockId: "tu-dead",
    turnId,
    agentName: agent,
    sessionId: session,
    messageId: "msg-dead",
    blockIndex: 0,
    role: "assistant",
    kind: "tool_use",
    contentJson: "",
    status: "streaming",
    ts: 1,
  });
  blockStream.__seedForTest({
    turnId,
    agent,
    sessionId: session,
    blocks: [
      {
        blockId: "tu-dead",
        clientBlockId: "c-tu-dead",
        turnId,
        agentName: agent,
        sessionId: session,
        messageId: "msg-dead",
        blockIndex: 0,
        role: "assistant",
        kind: "tool_use",
        source: null,
        tool: { id: "toolu_DEAD", name: "Bash" },
        text: "",
        partialJson: '{"command":"sleep',
        startedAt: 1,
      },
    ],
    startedAt: 1,
  });
}

describe("FRI-145 M5: hard-exit self-heal (AC #9)", () => {
  it("a turn-in-flight hard exit publishes turn_done(error), finalizes blocks, heals to idle", async () => {
    const NAME = "dead-agent";
    const TURN = "turn-dead-1";
    await registry.registerAgent({ name: NAME, type: "builder", parentName: "friday" });
    await registry.setStatus(NAME, "working");
    await seedStreamingBlock(TURN, NAME, "sess-dead-1");

    const publishSpy = vi.spyOn(bus.eventBus, "publish");
    const w = makeFakeWorker({ agentName: NAME, turnId: TURN, status: "working" });

    // The exit handler demotes the Generation up front; emulate that then drive
    // the self-heal exactly as `child.on("exit")` does (fire-and-forget there).
    await lifecycle.finalizeHardExit(w as never);

    // (1) the MISSING terminal event is now published for the dead turn.
    const turnDones = publishSpy.mock.calls.map((c) => c[0]).filter((e) => e.type === "turn_done");
    expect(turnDones).toHaveLength(1);
    expect(turnDones[0]).toMatchObject({
      type: "turn_done",
      turn_id: TURN,
      agent: NAME,
      status: "error",
    });

    // (2) a canonical in-band error event also fired for the dead turn.
    const errors = publishSpy.mock.calls.map((c) => c[0]).filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "error", turn_id: TURN, agent: NAME });

    // (3) the streaming block was finalized off `streaming` as error.
    const { getBlockById } = await import("@friday/shared/services");
    expect((await getBlockById("tu-dead"))?.status).toBe("error");

    // (4) the row projects idle — dispatchable, no sticky dead state.
    expect((await registry.getAgent(NAME))?.status).toBe("idle");
  });

  it("after a hard exit the agent is dispatchable again (a fresh fork can claim the name)", async () => {
    const NAME = "redispatch-agent";
    const TURN = "turn-redispatch-1";
    await registry.registerAgent({ name: NAME, type: "builder", parentName: "friday" });
    await registry.setStatus(NAME, "working");

    const w = makeFakeWorker({ agentName: NAME, turnId: TURN, status: "working" });
    await lifecycle.finalizeHardExit(w as never);

    // Self-healed to idle, no live worker → the next dispatch would spawn a
    // fresh fork (dispatchTurn's no-live-worker branch). Pin the dispatchable
    // pre-state the way `dispatchTurn` reads it: row idle + not live.
    expect((await registry.getAgent(NAME))?.status).toBe("idle");
    expect(lifecycle.isAgentLive(NAME)).toBe(false);
  });

  it("a between-turns hard exit (no live turn) heals to idle WITHOUT a phantom turn_done", async () => {
    const NAME = "between-turns-agent";
    await registry.registerAgent({ name: NAME, type: "builder", parentName: "friday" });
    await registry.setStatus(NAME, "working");

    const publishSpy = vi.spyOn(bus.eventBus, "publish");
    // turnStart undefined → the turn already reached a terminal event.
    const w = makeFakeWorker({
      agentName: NAME,
      turnId: "turn-between",
      turnStart: undefined,
      status: "working",
    });

    await lifecycle.finalizeHardExit(w as never);

    // No phantom turn_done for a worker that wasn't mid-turn.
    const turnDones = publishSpy.mock.calls.map((c) => c[0]).filter((e) => e.type === "turn_done");
    expect(turnDones).toHaveLength(0);
    // Still heals to idle.
    expect((await registry.getAgent(NAME))?.status).toBe("idle");
  });

  it("preserves a terminal `archived` row (a racing archive owns it) — no idle clobber", async () => {
    const NAME = "archived-on-exit";
    await registry.registerAgent({ name: NAME, type: "builder", parentName: "friday" });
    await registry.setStatus(NAME, "working");
    // A racing archive committed `archived` before the exit self-heal runs.
    await registry.archiveAgent(NAME, { reason: "abandoned" });

    const publishSpy = vi.spyOn(bus.eventBus, "publish");
    const w = makeFakeWorker({ agentName: NAME, turnId: "turn-arch", status: "working" });

    await lifecycle.finalizeHardExit(w as never);

    // The archived terminal is preserved — NOT reset to idle (F1-A).
    expect((await registry.getAgent(NAME))?.status).toBe("archived");
    // No turn_done published — the archive already tore the turn down.
    const turnDones = publishSpy.mock.calls.map((c) => c[0]).filter((e) => e.type === "turn_done");
    expect(turnDones).toHaveLength(0);
  });
});
