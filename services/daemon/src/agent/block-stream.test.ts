/**
 * FRI-125 — block-stream golden tests.
 *
 * One scenario per public write path (open/append/close cleanly,
 * open/append/cancel mid-turn, recordError, finalize on archive),
 * plus a tool-use variant of the clean path that exercises the
 * partial-JSON delta accumulator. Each scenario captures
 * `{ events, dbRows, snapshotAfter }` and snapshots it as JSON
 * against a checked-in golden file.
 *
 * Determinism:
 *   - `randomUUID` is mocked with a counter that resets per test
 *     (`uuid-1`, `uuid-2`, …). The crypto mock is hoisted so that
 *     `block-stream.ts`'s static `import { randomUUID } from
 *     "node:crypto"` binds to the mock at module load.
 *   - `Date.now` is faked via `vi.useFakeTimers({ toFake: ["Date"] })`
 *     so every `ts` field in events + rows lands at the same
 *     baseline. setTimeout / setInterval are NOT faked so the
 *     test DB's async truncate doesn't hang.
 *   - `seq` is stripped from captured events before snapshot — the
 *     eventBus singleton monotonically increments seq across tests
 *     in the same file (no public reset), so snapshots would
 *     otherwise be test-order-dependent.
 *
 * Test DB: real Postgres via `createTestDb`. Truncated between
 * tests. `block-stream.__resetForTest()` clears the in-memory
 * accumulator between tests.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";

const uuidState = vi.hoisted(() => ({ n: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () =>
      `uuid-${++uuidState.n}` as `${string}-${string}-${string}-${string}-${string}`,
  };
});

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "block_stream" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  uuidState.n = 0;
  vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ["Date"] });
  const { __resetForTest } = await import("./block-stream.js");
  __resetForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

/* ---------------- Helpers ---------------- */

interface FakeWorkerOverrides {
  turnId?: string;
  sessionId?: string;
  agentName?: string;
  agentType?: string;
  blocksThisTurn?: number;
}

function makeFakeWorker(o: FakeWorkerOverrides = {}): unknown {
  return {
    child: { send: () => {} },
    pgid: 0,
    agentName: o.agentName ?? "test-agent",
    agentType: o.agentType ?? "orchestrator",
    model: "claude-opus-4-7",
    turnId: o.turnId ?? "turn-1",
    sessionId: o.sessionId ?? "sess-1",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: 1_700_000_000_000,
    turnStart: 1_700_000_000_000,
    spawnedAt: 1_700_000_000_000,
    lastBlockStop: 1_700_000_000_000,
    status: "working",
    nextPrompts: [],
    mode: "long-lived",
    lastExitStatus: "complete",
    completedAtLeastOnce: false,
    blocksThisTurn: o.blocksThisTurn ?? 0,
  };
}

interface WireEventLike {
  type: string;
  seq?: number;
  [k: string]: unknown;
}

function stripSeq(events: WireEventLike[]): unknown[] {
  return events.map((e) => {
    const copy: Record<string, unknown> = { ...e };
    delete copy.seq;
    return copy;
  });
}

interface CapturedTrace {
  events: unknown[];
  rows: unknown[];
  snapshotAfter: unknown[];
}

async function captureTrace(action: () => Promise<void>): Promise<CapturedTrace> {
  const { eventBus } = await import("../events/bus.js");
  const { snapshot } = await import("./block-stream.js");
  const captured: WireEventLike[] = [];
  const unsub = eventBus.subscribe((e) => captured.push(e as WireEventLike));
  try {
    await action();
  } finally {
    unsub();
  }
  const rows = await getDb().select().from(schema.blocks);
  return {
    events: stripSeq(captured),
    rows: rows.map((r) => ({
      blockId: r.blockId,
      turnId: r.turnId,
      agentName: r.agentName,
      sessionId: r.sessionId,
      role: r.role,
      kind: r.kind,
      source: r.source,
      blockIndex: r.blockIndex,
      messageId: r.messageId,
      contentJson: r.contentJson,
      status: r.status,
      streaming: r.streaming,
    })),
    snapshotAfter: snapshot().map((lt) => ({
      turnId: lt.turnId,
      agent: lt.agent,
      sessionId: lt.sessionId,
      startedAt: lt.startedAt,
      inFlight: [...lt.blocks.values()].map((b) => ({
        blockId: b.blockId,
        clientBlockId: b.clientBlockId,
        kind: b.kind,
        blockIndex: b.blockIndex,
        text: b.text,
        partialJson: b.partialJson,
      })),
    })),
  };
}

function serializeTrace(t: CapturedTrace): string {
  return JSON.stringify(t, null, 2);
}

/* ---------------- Scenarios ---------------- */

describe("block-stream (FRI-125)", () => {
  it("clean text turn: open → append × 3 → close", async () => {
    const { open, append, close } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-text-1" });

    const trace = await captureTrace(async () => {
      await open(worker as never, {
        type: "block-start",
        clientBlockId: "cb-1",
        kind: "text",
        blockIndex: 0,
        messageId: "msg-1",
      });
      await append(worker as never, {
        type: "block-delta",
        clientBlockId: "cb-1",
        delta: { text: "Hello, " },
      });
      await append(worker as never, {
        type: "block-delta",
        clientBlockId: "cb-1",
        delta: { text: "world" },
      });
      await append(worker as never, {
        type: "block-delta",
        clientBlockId: "cb-1",
        delta: { text: "!" },
      });
      await close(worker as never, {
        type: "block-stop",
        clientBlockId: "cb-1",
        contentJson: JSON.stringify({ text: "Hello, world!" }),
        status: "complete",
      });
    });

    expect(trace.rows.length).toBe(1);
    expect(trace.snapshotAfter[0]).toMatchObject({
      turnId: "turn-text-1",
      inFlight: [],
    });
    await expect(serializeTrace(trace)).toMatchFileSnapshot(
      "./__golden__/block-stream.clean_text_turn.json",
    );
  });

  it("tool-use turn: open(tool_use) → partial_json deltas → close", async () => {
    const { open, append, close } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-tu-1" });

    const trace = await captureTrace(async () => {
      await open(worker as never, {
        type: "block-start",
        clientBlockId: "cb-1",
        kind: "tool_use",
        blockIndex: 0,
        messageId: "msg-tu-1",
        tool: { id: "toolu_abc", name: "Bash" },
      });
      await append(worker as never, {
        type: "block-delta",
        clientBlockId: "cb-1",
        delta: { partial_json: '{"command":' },
      });
      await append(worker as never, {
        type: "block-delta",
        clientBlockId: "cb-1",
        delta: { partial_json: '"ls -la"' },
      });
      await append(worker as never, {
        type: "block-delta",
        clientBlockId: "cb-1",
        delta: { partial_json: "}" },
      });
      await close(worker as never, {
        type: "block-stop",
        clientBlockId: "cb-1",
        contentJson: JSON.stringify({
          tool_use_id: "toolu_abc",
          name: "Bash",
          input: { command: "ls -la" },
        }),
        status: "complete",
      });
    });

    expect(trace.rows.length).toBe(1);
    expect(trace.rows[0]).toMatchObject({
      kind: "tool_use",
      status: "complete",
    });
    await expect(serializeTrace(trace)).toMatchFileSnapshot(
      "./__golden__/block-stream.tool_use_turn.json",
    );
  });

  it("mid-turn cancel: open → append × 2 → cancel; no row persisted", async () => {
    const { open, append, cancel } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-cancel-1" });

    const trace = await captureTrace(async () => {
      await open(worker as never, {
        type: "block-start",
        clientBlockId: "cb-1",
        kind: "thinking",
        blockIndex: 0,
      });
      await append(worker as never, {
        type: "block-delta",
        clientBlockId: "cb-1",
        delta: { text: "Hmm…" },
      });
      await append(worker as never, {
        type: "block-delta",
        clientBlockId: "cb-1",
        delta: { text: " never mind." },
      });
      await cancel(worker as never, {
        type: "block-cancel",
        clientBlockId: "cb-1",
      });
    });

    // No row INSERTed — block_canceled never persists.
    expect(trace.rows.length).toBe(0);
    // The block is removed from the in-flight map; the turn entry remains.
    expect(trace.snapshotAfter[0]).toMatchObject({
      turnId: "turn-cancel-1",
      inFlight: [],
    });
    // Event sequence: block_start → 2 block_delta → block_canceled.
    expect((trace.events as { type: string }[]).map((e) => e.type)).toEqual([
      "block_start",
      "block_delta",
      "block_delta",
      "block_canceled",
    ]);
    await expect(serializeTrace(trace)).toMatchFileSnapshot(
      "./__golden__/block-stream.mid_turn_cancel.json",
    );
  });

  it("recordError: persists error block + emits block_start/complete pair", async () => {
    const { recordError } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-err-1" });

    let resultBlockId: string | undefined;
    const trace = await captureTrace(async () => {
      const r = await recordError(worker as never, {
        code: "overloaded",
        headline: "Anthropic temporarily overloaded — usually clears in a moment",
        httpStatus: 529,
        requestId: "req_xyz",
        rawMessage: '529 {"type":"error","error":{"type":"overloaded_error"}}',
      });
      resultBlockId = r?.blockId;
    });

    expect(resultBlockId).toBe("uuid-1");
    expect(trace.rows.length).toBe(1);
    expect(trace.rows[0]).toMatchObject({
      kind: "error",
      status: "complete",
      role: "assistant",
    });
    // recordError uses the post-finalize fallback block_index (9999) when
    // there's no live turn in the accumulator — true here because the
    // worker has no prior open() calls.
    expect(trace.rows[0]).toMatchObject({ blockIndex: 9999 });
    // SSE pair: block_start + block_complete, both with kind=error.
    const eventTypes = (trace.events as { type: string; kind?: string }[]).map((e) => e.type);
    expect(eventTypes).toEqual(["block_start", "block_complete"]);
    await expect(serializeTrace(trace)).toMatchFileSnapshot(
      "./__golden__/block-stream.record_error.json",
    );
  });

  it("forced finalize: open(text) + open(tool_use) → finalize('aborted') publishes 2 block_complete", async () => {
    const { open, append, finalize, endTurn } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-fin-1" });

    const trace = await captureTrace(async () => {
      await open(worker as never, {
        type: "block-start",
        clientBlockId: "cb-text",
        kind: "text",
        blockIndex: 0,
      });
      await append(worker as never, {
        type: "block-delta",
        clientBlockId: "cb-text",
        delta: { text: "partial..." },
      });
      await open(worker as never, {
        type: "block-start",
        clientBlockId: "cb-tu",
        kind: "tool_use",
        blockIndex: 1,
        tool: { id: "toolu_def", name: "Read" },
      });
      await append(worker as never, {
        type: "block-delta",
        clientBlockId: "cb-tu",
        delta: { partial_json: '{"path":"/etc' },
      });
      await finalize(worker as never, "aborted");
      endTurn("turn-fin-1");
    });

    // Per ADR-024 + Phase 5: open() doesn't INSERT, so updateBlock during
    // finalize is a silent no-op on non-existent rows. No rows persist.
    expect(trace.rows.length).toBe(0);
    // After endTurn, the LiveTurn entry is gone.
    expect(trace.snapshotAfter).toEqual([]);
    // Events: 2× block_start, 2× block_delta (one per block), 2×
    // block_complete (one per in-flight block during finalize). The
    // finalize-emitted block_completes carry the assembled content_json
    // for each kind.
    const eventTypes = (trace.events as { type: string }[]).map((e) => e.type);
    expect(eventTypes).toEqual([
      "block_start",
      "block_delta",
      "block_start",
      "block_delta",
      "block_complete",
      "block_complete",
    ]);
    const finalizeCompletes = (trace.events as { type: string; status?: string }[]).filter(
      (e) => e.type === "block_complete",
    );
    expect(finalizeCompletes.every((e) => e.status === "aborted")).toBe(true);
    await expect(serializeTrace(trace)).toMatchFileSnapshot(
      "./__golden__/block-stream.forced_finalize.json",
    );
  });

  it("endTurn after open() drops the LiveTurn entry from the accumulator", async () => {
    const { open, endTurn, snapshot } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-end-1" });

    await open(worker as never, {
      type: "block-start",
      clientBlockId: "cb-1",
      kind: "text",
      blockIndex: 0,
    });
    expect(snapshot().length).toBe(1);

    endTurn("turn-end-1");
    expect(snapshot()).toEqual([]);
  });

  it("__seedForTest seeds the accumulator without driving public IPC", async () => {
    const { __seedForTest, snapshot } = await import("./block-stream.js");

    __seedForTest({
      turnId: "turn-seed-1",
      agent: "seeded",
      sessionId: "sess-seed",
      blocks: [
        {
          blockId: "uuid-seeded-1",
          clientBlockId: "cb-seeded-1",
          turnId: "turn-seed-1",
          agentName: "seeded",
          sessionId: "sess-seed",
          messageId: null,
          blockIndex: 0,
          role: "assistant",
          kind: "text",
          source: null,
          text: "seeded text",
          partialJson: "",
          startedAt: 1_700_000_000_000,
        },
      ],
      startedAt: 1_700_000_000_000,
    });

    const snap = snapshot();
    expect(snap.length).toBe(1);
    expect(snap[0].turnId).toBe("turn-seed-1");
    expect(snap[0].blocks.size).toBe(1);
  });
});
