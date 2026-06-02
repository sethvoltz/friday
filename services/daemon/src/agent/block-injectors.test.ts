/**
 * FRI-148 B — block-injectors tests.
 *
 * Pin the two synthetic block writers split out of block-stream.ts under the
 * Phase B refactor:
 *
 *   - recordError: synthesizes an `error` row + the SSE block_start/complete
 *     pair, falling back to blockIndex=9999 when the live turn has already
 *     been finalized (the load-bearing behaviour preserved per ticket §3).
 *   - recordUserBlock: persists a user-role block + emits block_complete
 *     even when no live turn is registered with the FSM accumulator (the
 *     POST-before-spawn / fresh-fork path).
 *
 * The cross-boundary test asserts the new module wiring: recordError calls
 * the block-stream module's `peekNextBlockIndex` accessor exactly once with
 * the worker's turnId — pinning the split's intended seam so a future
 * refactor can't silently inline a parallel accumulator-peek path.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";

// vi.hoisted: the wrapper must exist before block-stream.js loads (its `peekNextBlockIndex`
// export is what block-injectors.js binds against at module-eval time). The wrapper records
// every call AND delegates to the real implementation, so behaviour is unchanged and the
// recordError 9999-fallback path still exercises the real `turns` map state.
const peekState = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("./block-stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./block-stream.js")>();
  return {
    ...actual,
    peekNextBlockIndex: (turnId: string) => {
      peekState.calls.push(turnId);
      return actual.peekNextBlockIndex(turnId);
    },
  };
});

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
  handle = await createTestDb({ label: "block_injectors" });
  // Pre-load the eventBus module before any test runs: its module-level
  // `BOOT_ID = randomUUID()` would otherwise consume the first uuid mint of
  // the first test (since beforeEach resets uuidState.n to 0 but the
  // module-eval randomUUID call only fires once). Importing here moves that
  // single consumption outside the per-test uuid sequence so every test sees
  // a clean uuid-1 → uuid-N progression for the work it drove itself.
  await import("../events/bus.js");
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  uuidState.n = 0;
  peekState.calls = [];
  vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ["Date"] });
  const { __resetForTest } = await import("./block-stream.js");
  __resetForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

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

describe("block-injectors.recordError (FRI-148 B)", () => {
  it("persists an error block + emits block_start/complete pair (no live turn → blockIndex 9999)", async () => {
    const { recordError } = await import("./block-injectors.js");
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
    // FRI-148 §3 design correction: the 9999 fallback is load-bearing. A turn
    // with no entry in the FSM accumulator (post-finalize, or recordError fired
    // before any worker open()) must NOT throw and must NOT race a numeric
    // collision with a sibling — 9999 sorts last by convention.
    expect(trace.rows[0]).toMatchObject({ blockIndex: 9999 });
    const eventTypes = (trace.events as { type: string; kind?: string }[]).map((e) => e.type);
    expect(eventTypes).toEqual(["block_start", "block_complete"]);
    await expect(serializeTrace(trace)).toMatchFileSnapshot(
      "./__golden__/block-injectors.record_error.json",
    );
  });

  it("calls peekNextBlockIndex exactly once with the worker's turnId (cross-module seam)", async () => {
    // Cross-boundary pin: the Phase B split factored the accumulator peek out
    // into block-stream.peekNextBlockIndex and made it the only legal way for
    // block-injectors to know about the FSM's in-memory state. If a future
    // refactor inlines a parallel peek (e.g. re-imports the private `turns`
    // map), this assertion catches it.
    const { recordError } = await import("./block-injectors.js");
    const worker = makeFakeWorker({ turnId: "turn-peek-1" });

    await recordError(worker as never, {
      code: "x",
      headline: "y",
      rawMessage: "z",
    });

    expect(peekState.calls).toEqual(["turn-peek-1"]);
  });
});

describe("block-injectors.recordUserBlock (FRI-148 B)", () => {
  it("persists a user-role row + emits block_complete even without a live turn in the FSM accumulator", async () => {
    // The POST-before-spawn / fresh-fork path: recordUserBlock is called
    // before any open() runs for the turn, so the FSM accumulator has no
    // entry for this turnId. The injector must still land a row and publish
    // the SSE frame — block-index 0 (user blocks are always the head of
    // their turn). Phase B parity test for the previously-block-stream-
    // local function now imported from block-injectors.js.
    const { recordUserBlock } = await import("./block-injectors.js");
    const { eventBus } = await import("../events/bus.js");
    const { getBlockById } = await import("@friday/shared/services");
    const { snapshot } = await import("./block-stream.js");

    // Sanity: no live turn in the accumulator before we call.
    expect(snapshot()).toEqual([]);

    const captured: Array<{ type?: string; block_id?: string; status?: string; role?: string }> =
      [];
    const unsub = eventBus.subscribe((e) =>
      captured.push(
        e as { type?: string; block_id?: string; status?: string; role?: string },
      ),
    );

    const { blockId, seq } = await recordUserBlock({
      turnId: "turn-injector-user-1",
      agentName: "alpha",
      text: "hello from outside the FSM",
      source: "user_chat",
    });
    unsub();

    // Row landed with the expected shape — proves the INSERT ran.
    const row = await getBlockById(blockId);
    expect(row).not.toBeNull();
    expect(row!.role).toBe("user");
    expect(row!.kind).toBe("text");
    expect(row!.source).toBe("user_chat");
    expect(row!.status).toBe("complete");
    expect(row!.blockIndex).toBe(0);
    expect(JSON.parse(row!.contentJson)).toEqual({ text: "hello from outside the FSM" });

    // block_complete SSE fired with the load-bearing fields and the returned
    // seq matches the published frame.
    expect(seq).toBeGreaterThan(0);
    const evt = captured.find((e) => e.type === "block_complete" && e.block_id === blockId);
    expect(evt).toBeDefined();
    expect(evt!.role).toBe("user");
    expect(evt!.status).toBe("complete");

    // recordUserBlock does NOT touch the FSM accumulator — the snapshot
    // stays empty (unlike open(), which seeds a LiveTurn entry).
    expect(snapshot()).toEqual([]);
  });
});
