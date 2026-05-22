import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";

// FRI-12: when the worker emits an `error` IPC (SDK threw — 529, 429, 401,
// network), the lifecycle handler must (a) persist a `kind="error"` block,
// (b) publish block_start + block_complete + turn_done SSE events in order,
// and (c) clear the agent's "running" state. Previously: only TurnErrorEvent
// was published, no block was persisted, no turn_done fired — the dashboard
// bubble hung in `running` until daemon restart.

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_error" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

function makeFakeWorker(overrides: Record<string, unknown> = {}): unknown {
  return {
    child: { send: () => {} },
    pgid: 0,
    agentName: "test-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "turn-err-1",
    sessionId: "sess-err-1",
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
    ...overrides,
  };
}

interface CapturedEvent {
  type: string;
  turn_id?: string;
  agent?: string;
  status?: string;
  block_id?: string;
  kind?: string;
  content_json?: string;
  code?: string;
  message?: string;
  recoverable?: boolean;
  seq?: number;
}

describe("lifecycle.handleEvent on `error` IPC (FRI-12)", () => {
  it("persists an error block + emits block_start/complete/turn_done for an SDK 529", async () => {
    const { handleEvent } = await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    const worker = makeFakeWorker() as { status: string };
    // Await handleEvent — it runs `await registry.setStatus(agent, 'idle')`
    // AFTER publishing turn_done. Without the await, that pool UPDATE
    // can still be in flight when afterAll's dropTestDb fires
    // pg_terminate_backend, producing an unhandled `57P01 terminating
    // connection due to administrator command` that fails the run even
    // though every assertion passes.
    await handleEvent(worker as never, {
      type: "error",
      message: "Anthropic temporarily overloaded — usually clears in a moment",
      recoverable: false,
      code: "overloaded",
      headline: "Anthropic temporarily overloaded — usually clears in a moment",
      httpStatus: 529,
      requestId: "req_abc",
      rawMessage: `529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`,
    });
    // Belt-and-braces: turn_done is the last event in the error chain
    // and is already published by the time handleEvent returns; the
    // waitFor is now a fast no-op but kept so the assertion below
    // reads from `captured` with the same shape.
    await vi.waitFor(
      () =>
        expect(
          captured.find(
            (e) => e.type === "turn_done" && e.turn_id === "turn-err-1",
          ),
        ).toBeDefined(),
      { timeout: 5000, interval: 25 },
    );
    unsub();

    // (a) one error block row exists for this turn.
    const rows = await getDb()
      .select()
      .from(schema.blocks)
      .where(eq(schema.blocks.turnId, "turn-err-1"));
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.kind).toBe("error");
    expect(row.role).toBe("assistant");
    expect(row.status).toBe("complete");
    const payload = row.contentJson as Record<string, unknown>;
    expect(payload).toMatchObject({
      code: "overloaded",
      httpStatus: 529,
      requestId: "req_abc",
    });
    expect(payload.headline).toContain("overloaded");
    expect(payload.rawMessage).toContain("529");

    // (b) the SSE event sequence: block_start → block_complete → error → turn_done.
    const blockEvents = captured.filter((e) => e.block_id === row.blockId);
    expect(blockEvents.map((e) => e.type)).toEqual([
      "block_start",
      "block_complete",
    ]);
    const completeEvent = blockEvents[1];
    expect(completeEvent.kind).toBe("error");
    expect(completeEvent.status).toBe("complete");

    const errEvent = captured.find(
      (e) => e.type === "error" && e.turn_id === "turn-err-1",
    );
    expect(errEvent).toBeDefined();
    expect(errEvent!.code).toBe("overloaded");

    const doneEvent = captured.find(
      (e) => e.type === "turn_done" && e.turn_id === "turn-err-1",
    );
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.status).toBe("error");
    expect(doneEvent!.agent).toBe("test-agent");

    // Ordering: block_complete strictly before turn_done so a client
    // applying events in seq order materializes the bubble before the
    // turn flips terminal.
    const completeIdx = captured.findIndex(
      (e) => e.type === "block_complete" && e.block_id === row.blockId,
    );
    const doneIdx = captured.findIndex(
      (e) => e.type === "turn_done" && e.turn_id === "turn-err-1",
    );
    expect(completeIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(completeIdx);

    // (c) Phase 5: `agent_status` SSE retired. The status flip is
    // observable via setWorkerStatus mutating the live worker's
    // `status` field (and via the registry UPDATE Zero replicates
    // when the agent has a registry row — this fake worker doesn't
    // pre-register so we assert the in-memory worker state here).
    expect(worker.status).toBe("idle");
  });

  it("aborted branch emits turn_done(aborted) but does NOT insert an error block", async () => {
    const { handleEvent } = await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    await handleEvent(
      makeFakeWorker({ turnId: "turn-abort-1", abortRequested: true }) as never,
      {
        type: "error",
        message: "aborted",
        recoverable: true,
      },
    );
    // The aborted branch skips insertErrorBlock entirely — wait on the
    // observable signal that the error path ran (turn_done aborted).
    await vi.waitFor(
      () =>
        expect(
          captured.find(
            (e) => e.type === "turn_done" && e.turn_id === "turn-abort-1",
          ),
        ).toBeDefined(),
      { timeout: 5000, interval: 25 },
    );
    unsub();

    const rows = await getDb()
      .select()
      .from(schema.blocks)
      .where(eq(schema.blocks.turnId, "turn-abort-1"));
    expect(rows.length).toBe(0);

    const errEvent = captured.find(
      (e) => e.type === "error" && e.turn_id === "turn-abort-1",
    );
    expect(errEvent!.code).toBe("aborted");

    const doneEvent = captured.find(
      (e) => e.type === "turn_done" && e.turn_id === "turn-abort-1",
    );
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.status).toBe("aborted");
  });

  it("preserves the rate-limit retry hint through to the persisted block", async () => {
    const { handleEvent } = await import("./lifecycle.js");

    await handleEvent(makeFakeWorker({ turnId: "turn-rl-1" }) as never, {
      type: "error",
      message: "Rate limited",
      recoverable: false,
      code: "rate_limited",
      headline: "Rate limited",
      httpStatus: 429,
      retryAfterSeconds: 30,
      rawMessage: `429 {"error":{"message":"slow down"}}`,
    });
    await vi.waitFor(
      async () => {
        const rows = await getDb()
          .select()
          .from(schema.blocks)
          .where(eq(schema.blocks.turnId, "turn-rl-1"));
        expect(rows.length).toBe(1);
        const payload = rows[0].contentJson as Record<string, unknown>;
        expect(payload.retryAfterSeconds).toBe(30);
        expect(payload.code).toBe("rate_limited");
      },
      { timeout: 5000, interval: 25 },
    );
  });

  it("falls back to e.message when classifier fields are absent", async () => {
    // Defensive: an old worker (or the one-shot scheduled-agent path that
    // hasn't been updated to call classifySdkError) might emit an error
    // IPC without the structured fields. We still persist the bubble.
    const { handleEvent } = await import("./lifecycle.js");

    await handleEvent(makeFakeWorker({ turnId: "turn-bare-1" }) as never, {
      type: "error",
      message: "something blew up",
      recoverable: false,
    });
    await vi.waitFor(
      async () => {
        const rows = await getDb()
          .select()
          .from(schema.blocks)
          .where(eq(schema.blocks.turnId, "turn-bare-1"));
        expect(rows.length).toBe(1);
        const payload = rows[0].contentJson as Record<string, unknown>;
        expect(payload.code).toBe("worker_error");
        expect(payload.headline).toBe("something blew up");
        expect(payload.rawMessage).toBe("something blew up");
      },
      { timeout: 5000, interval: 25 },
    );
  });
});
