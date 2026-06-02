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

  it("forced finalize: open(text) + open(tool_use) → tearDownTurn('aborted') publishes 2 block_complete + drops turn", async () => {
    // FRI-148 A: finalize + endTurn fused into tearDownTurn. The golden file
    // shape is unchanged — same per-block_complete SSEs, same DB writes —
    // because tearDownTurn is finalize + turns.delete, and the deletion is
    // observable only through the post-call snapshot (empty).
    const { open, append, tearDownTurn } = await import("./block-stream.js");
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
      await tearDownTurn(worker as never, "aborted");
    });

    // FRI-145 M6: an in-flight block has NO canonical row yet (ADR-024:
    // open/append never INSERT). finalize is the block's FIRST terminal write,
    // so it INSERTs each in-flight block born-closed with `streaming=false` —
    // it does NOT issue the old zero-row UPDATE. Two in-flight blocks → two
    // rows, both `status='aborted'`, `streaming=false`.
    expect(trace.rows.length).toBe(2);
    // `getDb().select()` returns rows in unspecified order; sort by blockIndex
    // for a deterministic pin.
    const finalizeRows = [...(trace.rows as { blockIndex: number }[])].sort(
      (a, b) => a.blockIndex - b.blockIndex,
    );
    expect(finalizeRows).toEqual([
      {
        blockId: "uuid-1",
        turnId: "turn-fin-1",
        agentName: "test-agent",
        sessionId: "sess-1",
        role: "assistant",
        kind: "text",
        source: null,
        blockIndex: 0,
        messageId: null,
        contentJson: { text: "partial..." },
        status: "aborted",
        streaming: false,
      },
      {
        blockId: "uuid-2",
        turnId: "turn-fin-1",
        agentName: "test-agent",
        sessionId: "sess-1",
        role: "assistant",
        kind: "tool_use",
        source: null,
        blockIndex: 1,
        messageId: null,
        contentJson: {
          tool_use_id: "toolu_def",
          name: "Read",
          // partial_json '{"path":"/etc' is unparseable → captured under _raw.
          input: { _raw: '{"path":"/etc' },
        },
        status: "aborted",
        streaming: false,
      },
    ]);
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

  it("tearDownTurn after open() drops the LiveTurn entry from the accumulator", async () => {
    // FRI-148 A: the bare endTurn export retired — tearDownTurn fuses
    // finalize + drop. Driving it against an open-only turn finalizes the
    // single in-flight block (writes a row with the supplied terminal
    // status) AND drops the LiveTurn entry from the accumulator.
    const { open, tearDownTurn, snapshot } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-end-1" });

    await open(worker as never, {
      type: "block-start",
      clientBlockId: "cb-1",
      kind: "text",
      blockIndex: 0,
    });
    expect(snapshot().length).toBe(1);

    await tearDownTurn(worker as never, "aborted");
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

/* ---------------- FRI-145 M6: per-block state machine ---------------- */

describe("block-stream per-block state machine (FRI-145 M6)", () => {
  async function dbRowCount(): Promise<number> {
    const rows = await getDb().select().from(schema.blocks);
    return rows.length;
  }

  it("valid start → delta → close writes exactly one row with streaming=0", async () => {
    const { open, append, close } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-m6-ok" });

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
      delta: { text: "hi" },
    });
    await close(worker as never, {
      type: "block-stop",
      clientBlockId: "cb-1",
      contentJson: JSON.stringify({ text: "hi" }),
      status: "complete",
    });

    const rows = await getDb().select().from(schema.blocks);
    expect(rows.length).toBe(1);
    // ADR-024: the canonical row's first existence is at close, born with
    // streaming=false (schema default — open/append never INSERT).
    expect(rows[0]).toMatchObject({
      blockId: "uuid-1",
      turnId: "turn-m6-ok",
      kind: "text",
      status: "complete",
      streaming: false,
    });
  });

  it("double-close: the second close is rejected (BLOCK_ALREADY_CLOSED) and writes no second row", async () => {
    const { open, close } = await import("./block-stream.js");
    const { IllegalBlockTransitionError } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-m6-dc" });

    await open(worker as never, {
      type: "block-start",
      clientBlockId: "cb-1",
      kind: "text",
      blockIndex: 0,
    });
    const stop = {
      type: "block-stop" as const,
      clientBlockId: "cb-1",
      contentJson: JSON.stringify({ text: "done" }),
      status: "complete" as const,
    };
    // First close: legal — INSERTs the canonical row.
    await close(worker as never, stop);
    expect(await dbRowCount()).toBe(1);
    const rowsAfterFirst = await getDb().select().from(schema.blocks);
    const firstRow = rowsAfterFirst[0];

    // Second close: a protocol violation. It must REJECT (not silently no-op,
    // and not fire a dup-key INSERT). Assert the exact code + the loose-match
    // pattern AC #12 names.
    let thrown: unknown;
    try {
      await close(worker as never, stop);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IllegalBlockTransitionError);
    expect((thrown as InstanceType<typeof IllegalBlockTransitionError>).code).toBe(
      "BLOCK_ALREADY_CLOSED",
    );
    expect((thrown as Error).message).toMatch(/illegal|already.closed/i);

    // No second INSERT, no mutation: exactly one row, byte-identical to the
    // first close's row (proves the rejected close issued no write at all).
    const rowsAfterSecond = await getDb().select().from(schema.blocks);
    expect(rowsAfterSecond.length).toBe(1);
    expect(rowsAfterSecond[0]).toEqual(firstRow);
  });

  it("delta-after-close: append is rejected (BLOCK_ALREADY_CLOSED) and issues no zero-row UPDATE", async () => {
    const { open, append, close } = await import("./block-stream.js");
    const { IllegalBlockTransitionError } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-m6-dac" });

    await open(worker as never, {
      type: "block-start",
      clientBlockId: "cb-1",
      kind: "text",
      blockIndex: 0,
    });
    await close(worker as never, {
      type: "block-stop",
      clientBlockId: "cb-1",
      contentJson: JSON.stringify({ text: "closed" }),
      status: "complete",
    });
    const rowsBefore = await getDb().select().from(schema.blocks);
    expect(rowsBefore.length).toBe(1);

    let thrown: unknown;
    try {
      await append(worker as never, {
        type: "block-delta",
        clientBlockId: "cb-1",
        delta: { text: " late" },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IllegalBlockTransitionError);
    expect((thrown as InstanceType<typeof IllegalBlockTransitionError>).code).toBe(
      "BLOCK_ALREADY_CLOSED",
    );

    // The DB is untouched — no zero-row UPDATE was issued against the closed
    // row, no new row appeared.
    const rowsAfter = await getDb().select().from(schema.blocks);
    expect(rowsAfter).toEqual(rowsBefore);
  });

  it("append-before-start: rejected (BLOCK_NOT_STARTED), no row written", async () => {
    const { append } = await import("./block-stream.js");
    const { IllegalBlockTransitionError } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-m6-abs" });

    let thrown: unknown;
    try {
      await append(worker as never, {
        type: "block-delta",
        clientBlockId: "cb-never-opened",
        delta: { text: "orphan" },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IllegalBlockTransitionError);
    expect((thrown as InstanceType<typeof IllegalBlockTransitionError>).code).toBe(
      "BLOCK_NOT_STARTED",
    );
    expect((thrown as InstanceType<typeof IllegalBlockTransitionError>).op).toBe("append");
    expect(await dbRowCount()).toBe(0);
  });

  it("close-before-start: rejected (BLOCK_NOT_STARTED), no row written", async () => {
    const { close } = await import("./block-stream.js");
    const { IllegalBlockTransitionError } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-m6-cbs" });

    let thrown: unknown;
    try {
      await close(worker as never, {
        type: "block-stop",
        clientBlockId: "cb-never-opened",
        contentJson: JSON.stringify({ text: "x" }),
        status: "complete",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IllegalBlockTransitionError);
    expect((thrown as InstanceType<typeof IllegalBlockTransitionError>).code).toBe(
      "BLOCK_NOT_STARTED",
    );
    expect(await dbRowCount()).toBe(0);
  });

  it("double-start: re-opening an in-flight block id is rejected (BLOCK_ALREADY_STARTED), no spurious block_start SSE, no counter inflation", async () => {
    const { open } = await import("./block-stream.js");
    const { IllegalBlockTransitionError } = await import("./block-stream.js");
    const { eventBus } = await import("../events/bus.js");
    const worker = makeFakeWorker({ turnId: "turn-m6-ds", blocksThisTurn: 0 });

    const startEvents: unknown[] = [];
    const unsub = eventBus.subscribe((e) => {
      if ((e as { type?: string }).type === "block_start") startEvents.push(e);
    });

    await open(worker as never, {
      type: "block-start",
      clientBlockId: "cb-1",
      kind: "text",
      blockIndex: 0,
    });
    // First open: one block_start SSE, counter at 1.
    expect(startEvents.length).toBe(1);
    expect((worker as { blocksThisTurn: number }).blocksThisTurn).toBe(1);

    let thrown: unknown;
    try {
      await open(worker as never, {
        type: "block-start",
        clientBlockId: "cb-1",
        kind: "text",
        blockIndex: 1,
      });
    } catch (err) {
      thrown = err;
    }
    unsub();
    expect(thrown).toBeInstanceOf(IllegalBlockTransitionError);
    expect((thrown as InstanceType<typeof IllegalBlockTransitionError>).code).toBe(
      "BLOCK_ALREADY_STARTED",
    );
    // The rejected re-open published NO additional block_start and did NOT bump
    // the wedge counter — the guard fires before both side effects.
    expect(startEvents.length).toBe(1);
    expect((worker as { blocksThisTurn: number }).blocksThisTurn).toBe(1);
    // open() never INSERTs (ADR-024), so no row regardless; the guard's job is
    // to protect the accumulator entry from being clobbered, which we verify
    // via the snapshot: the original (blockIndex 0) entry survives intact.
    const { snapshot } = await import("./block-stream.js");
    const lt = snapshot().find((t) => t.turnId === "turn-m6-ds");
    expect(lt?.blocks.get("cb-1")?.blockIndex).toBe(0);
    expect(await dbRowCount()).toBe(0);
  });

  it("re-start after close is rejected (BLOCK_ALREADY_CLOSED), not silently re-opened", async () => {
    const { open, close } = await import("./block-stream.js");
    const { IllegalBlockTransitionError } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-m6-rsac" });

    await open(worker as never, {
      type: "block-start",
      clientBlockId: "cb-1",
      kind: "text",
      blockIndex: 0,
    });
    await close(worker as never, {
      type: "block-stop",
      clientBlockId: "cb-1",
      contentJson: JSON.stringify({ text: "done" }),
      status: "complete",
    });
    expect(await dbRowCount()).toBe(1);

    let thrown: unknown;
    try {
      await open(worker as never, {
        type: "block-start",
        clientBlockId: "cb-1",
        kind: "text",
        blockIndex: 0,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IllegalBlockTransitionError);
    expect((thrown as InstanceType<typeof IllegalBlockTransitionError>).code).toBe(
      "BLOCK_ALREADY_CLOSED",
    );
    // No spurious second row from the rejected re-open.
    expect(await dbRowCount()).toBe(1);
  });

  it("double-cancel: the second cancel is rejected (BLOCK_ALREADY_CLOSED)", async () => {
    const { open, cancel } = await import("./block-stream.js");
    const { IllegalBlockTransitionError } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-m6-dcancel" });

    await open(worker as never, {
      type: "block-start",
      clientBlockId: "cb-1",
      kind: "thinking",
      blockIndex: 0,
    });
    await cancel(worker as never, { type: "block-cancel", clientBlockId: "cb-1" });
    // cancel never persists a row.
    expect(await dbRowCount()).toBe(0);

    let thrown: unknown;
    try {
      await cancel(worker as never, { type: "block-cancel", clientBlockId: "cb-1" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IllegalBlockTransitionError);
    expect((thrown as InstanceType<typeof IllegalBlockTransitionError>).code).toBe(
      "BLOCK_ALREADY_CLOSED",
    );
    expect((thrown as InstanceType<typeof IllegalBlockTransitionError>).op).toBe("cancel");
    expect(await dbRowCount()).toBe(0);
  });

  it("close after cancel is rejected (BLOCK_ALREADY_CLOSED) — cancel is terminal", async () => {
    const { open, cancel, close } = await import("./block-stream.js");
    const { IllegalBlockTransitionError } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-m6-cac" });

    await open(worker as never, {
      type: "block-start",
      clientBlockId: "cb-1",
      kind: "text",
      blockIndex: 0,
    });
    await cancel(worker as never, { type: "block-cancel", clientBlockId: "cb-1" });

    let thrown: unknown;
    try {
      await close(worker as never, {
        type: "block-stop",
        clientBlockId: "cb-1",
        contentJson: JSON.stringify({ text: "x" }),
        status: "complete",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IllegalBlockTransitionError);
    expect((thrown as InstanceType<typeof IllegalBlockTransitionError>).code).toBe(
      "BLOCK_ALREADY_CLOSED",
    );
    // cancel persisted nothing and the rejected close added nothing.
    expect(await dbRowCount()).toBe(0);
  });

  it("close after tearDownTurn is rejected (BLOCK_ALREADY_CLOSED), no duplicate row", async () => {
    // FRI-148 A: finalize is internal now — drive the boundary through the
    // fused tearDownTurn. Semantically the same per-block terminal write
    // (and additionally drops the per-turn accumulator entry), so the late
    // close is still rejected as BLOCK_ALREADY_CLOSED.
    const { open, append, tearDownTurn, close } = await import("./block-stream.js");
    const { IllegalBlockTransitionError } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-m6-caf" });

    await open(worker as never, {
      type: "block-start",
      clientBlockId: "cb-1",
      kind: "text",
      blockIndex: 0,
    });
    await append(worker as never, {
      type: "block-delta",
      clientBlockId: "cb-1",
      delta: { text: "partial" },
    });
    // tearDownTurn INSERTs the in-flight block born-closed (status='aborted').
    await tearDownTurn(worker as never, "aborted");
    expect(await dbRowCount()).toBe(1);
    const rowsAfterFinalize = await getDb().select().from(schema.blocks);

    // A late block-stop for the now-finalized block must be rejected — not a
    // dup-key INSERT over the finalize row. Because tearDownTurn also dropped
    // the per-turn accumulator entry, the rejection code path here goes
    // through the "no live turn / no live block" branch — which still maps
    // to BLOCK_NOT_STARTED because `closed` is gone with the turn.
    let thrown: unknown;
    try {
      await close(worker as never, {
        type: "block-stop",
        clientBlockId: "cb-1",
        contentJson: JSON.stringify({ text: "too late" }),
        status: "complete",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IllegalBlockTransitionError);
    expect((thrown as InstanceType<typeof IllegalBlockTransitionError>).code).toBe(
      "BLOCK_NOT_STARTED",
    );
    const rowsAfter = await getDb().select().from(schema.blocks);
    expect(rowsAfter).toEqual(rowsAfterFinalize);
  });

  it("independent block ids in the same turn are unaffected by another block's terminal state", async () => {
    // The closed-set is keyed by clientBlockId, so closing cb-1 must NOT make
    // cb-2's open/delta/close illegal.
    const { open, append, close } = await import("./block-stream.js");
    const worker = makeFakeWorker({ turnId: "turn-m6-indep" });

    await open(worker as never, {
      type: "block-start",
      clientBlockId: "cb-1",
      kind: "text",
      blockIndex: 0,
    });
    await close(worker as never, {
      type: "block-stop",
      clientBlockId: "cb-1",
      contentJson: JSON.stringify({ text: "first" }),
      status: "complete",
    });

    // cb-2 is a different block — its full lifecycle is legal.
    await open(worker as never, {
      type: "block-start",
      clientBlockId: "cb-2",
      kind: "text",
      blockIndex: 1,
    });
    await append(worker as never, {
      type: "block-delta",
      clientBlockId: "cb-2",
      delta: { text: "second" },
    });
    await close(worker as never, {
      type: "block-stop",
      clientBlockId: "cb-2",
      contentJson: JSON.stringify({ text: "second" }),
      status: "complete",
    });

    expect(await dbRowCount()).toBe(2);
  });
});
