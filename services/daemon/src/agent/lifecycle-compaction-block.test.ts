/**
 * FRI-156 §D/§E: durable compaction-marker block.
 *
 * When the worker emits a `compaction-boundary` IPC (the SDK trimmed the
 * context window), lifecycle.handleEvent must INSERT a durable
 * `role='system' kind='compaction' status='complete'` block whose
 * `content_json` carries `{ pre_tokens, post_tokens, duration_ms }` (the
 * divider is rendered from this Zero-replicated row only — NO SSE block pair),
 * and bump `w.blocksThisTurn` so the durable divider REPLACES the synthesized
 * "Compacted — no response" bubble (zero_block_reason → undefined) and a legit
 * /compact turn doesn't advance the wedge streak.
 *
 * Harness mirrors lifecycle-error-block.test.ts: scratch PG via createTestDb,
 * handle.truncate per test, __putLiveWorkerForTest registration, getDb()/schema
 * reads.
 *
 * NOTE on the sibling unit tests staying green: lifecycle-zero-block-reason
 * .test.ts and turn-state-machine.test.ts drive the machine/handleEvent WITHOUT
 * a preceding compaction-boundary IPC, so `blocksThisTurn` stays 0 and the
 * machine's `blocksThisTurn===0 + compactionThisTurn → 'compaction'` mapping
 * still fires for them. THIS test fires the boundary IPC first, so
 * blocksThisTurn becomes 1 and that mapping is (correctly) bypassed.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";
import { insertBlock } from "@friday/shared/services";
import { logger } from "../log.js";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_compaction" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

function makeFakeWorker(overrides: Record<string, unknown> = {}) {
  const child = { send: () => {}, exitCode: null as number | null, killed: false };
  return {
    child,
    pgid: 0,
    agentName: "cmp-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "turn-cmp-1",
    sessionId: "sess-cmp-1",
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
}

interface CapturedEvent {
  type: string;
  turn_id?: string;
  agent?: string;
  block_id?: string;
  kind?: string;
  role?: string;
  status?: string;
  content_json?: string;
  block_index?: number;
  zero_block_reason?: string;
  phase?: string;
}

/** Insert a minimal `working` agent row so the `compacting_since` UPDATE
 *  (keyed on agent name) lands on a real row rather than no-opping. */
async function registerWorkingAgent(
  name: string,
  opts: { compactingSince?: Date | null } = {},
): Promise<void> {
  await getDb()
    .insert(schema.agents)
    .values({
      name,
      type: "orchestrator",
      status: "working",
      sessionCount: 0,
      compactingSince: opts.compactingSince ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
}

describe("lifecycle.handleEvent on `compaction-boundary` IPC (FRI-156 §D/§E)", () => {
  it("inserts exactly one durable kind='compaction' marker block with the token deltas", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    const worker = makeFakeWorker({ turnId: "turn-cmp-1" });
    __putLiveWorkerForTest(worker.agentName, worker as never);

    await handleEvent(
      worker as never,
      {
        type: "compaction-boundary",
        sessionId: "sess-cmp-1",
        preTokens: 779378,
        postTokens: 50000,
        durationMs: 1234,
      } as never,
    );

    __deleteLiveWorkerForTest(worker.agentName);
    unsub();

    const rows = await getDb()
      .select()
      .from(schema.blocks)
      .where(eq(schema.blocks.turnId, "turn-cmp-1"));
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.role).toBe("system");
    expect(row.kind).toBe("compaction");
    expect(row.status).toBe("complete");
    // content_json is jsonb (key order not preserved) — assert the parsed object.
    expect(row.contentJson).toEqual({
      pre_tokens: 779378,
      post_tokens: 50000,
      duration_ms: 1234,
    });
    // No live turn in the accumulator → sort-last 9999 fallback (same as recordError).
    expect(row.blockIndex).toBe(9999);

    // The divider is Zero-replication-driven ONLY: recordCompactionMarker does
    // NOT publish a block_start/block_complete SSE pair (the dashboard has no
    // kind:'compaction' SSE handler — such frames would be dead writes). Assert
    // no SSE block frame was emitted for the marker.
    const blockEvents = captured.filter((e) => e.block_id === row.blockId);
    expect(blockEvents).toEqual([]);
  });

  it("bumps w.blocksThisTurn to 1 on a successful insert (the SECOND writer)", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");

    const worker = makeFakeWorker({ turnId: "turn-cmp-bump", blocksThisTurn: 0 });
    __putLiveWorkerForTest(worker.agentName, worker as never);

    await handleEvent(
      worker as never,
      {
        type: "compaction-boundary",
        sessionId: "sess-cmp-1",
        preTokens: 100,
        postTokens: 20,
        durationMs: 5,
      } as never,
    );

    expect(worker.blocksThisTurn).toBe(1);
    __deleteLiveWorkerForTest(worker.agentName);
  });

  it("INTEGRATION: boundary-then-complete yields turn_done with NO zero_block_reason (marker counted)", async () => {
    // The compaction-boundary IPC is ordered before turn-complete; the marker
    // bumps blocksThisTurn to 1, so the turn-state machine's
    // blocksThisTurn===0+compactionThisTurn → 'compaction' mapping does NOT
    // fire — the durable divider replaces the synthesized "no response" bubble.
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    const worker = makeFakeWorker({ turnId: "turn-cmp-int", blocksThisTurn: 0 });
    __putLiveWorkerForTest(worker.agentName, worker as never);

    await handleEvent(
      worker as never,
      {
        type: "compaction-boundary",
        sessionId: "sess-cmp-1",
        preTokens: 779378,
        postTokens: 50000,
        durationMs: 1000,
      } as never,
    );
    await handleEvent(
      worker as never,
      {
        type: "turn-complete",
        sessionId: "sess-cmp-1",
        compactionThisTurn: true,
      } as never,
    );

    __deleteLiveWorkerForTest(worker.agentName);
    unsub();

    const done = captured.find((e) => e.type === "turn_done" && e.turn_id === "turn-cmp-int");
    expect(done).toBeDefined();
    expect(done?.zero_block_reason).toBeUndefined();
  });

  it("NEVER-RESET (AC#7 daemon side): existing blocks are untouched; only one new row is added", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");

    // Seed two pre-existing blocks on the turn (a user message + an assistant reply).
    await insertBlock({
      blockId: "pre-user-1",
      turnId: "turn-cmp-nr",
      agentName: "cmp-agent",
      sessionId: "sess-cmp-1",
      messageId: null,
      blockIndex: 0,
      role: "user",
      kind: "text",
      source: "user_chat",
      contentJson: JSON.stringify({ text: "summarize the project" }),
      status: "complete",
      ts: Date.now() - 2000,
    });
    await insertBlock({
      blockId: "pre-asst-1",
      turnId: "turn-cmp-nr",
      agentName: "cmp-agent",
      sessionId: "sess-cmp-1",
      messageId: null,
      blockIndex: 1,
      role: "assistant",
      kind: "text",
      source: null,
      contentJson: JSON.stringify({ text: "here is the summary" }),
      status: "complete",
      ts: Date.now() - 1000,
    });

    const before = await getDb()
      .select()
      .from(schema.blocks)
      .where(eq(schema.blocks.turnId, "turn-cmp-nr"));
    expect(before.length).toBe(2);
    const beforeById = new Map(before.map((r) => [r.blockId, r]));

    const worker = makeFakeWorker({ turnId: "turn-cmp-nr" });
    __putLiveWorkerForTest(worker.agentName, worker as never);
    await handleEvent(
      worker as never,
      {
        type: "compaction-boundary",
        sessionId: "sess-cmp-1",
        preTokens: 500,
        postTokens: 100,
        durationMs: 50,
      } as never,
    );
    __deleteLiveWorkerForTest(worker.agentName);

    const after = await getDb()
      .select()
      .from(schema.blocks)
      .where(eq(schema.blocks.turnId, "turn-cmp-nr"));
    // Exactly one new row (the marker); the two originals survive.
    expect(after.length).toBe(3);
    for (const id of ["pre-user-1", "pre-asst-1"]) {
      const orig = beforeById.get(id)!;
      const now = after.find((r) => r.blockId === id)!;
      // Byte-identical: compaction never mutates existing history (/clear only).
      expect(now.role).toBe(orig.role);
      expect(now.kind).toBe(orig.kind);
      expect(now.status).toBe(orig.status);
      expect(now.contentJson).toEqual(orig.contentJson);
      expect(now.ts.getTime()).toBe(orig.ts.getTime());
    }
    const markers = after.filter((r) => r.kind === "compaction");
    expect(markers.length).toBe(1);
  });

  it("duplicate-boundary isolation: two boundary frames insert two markers without throwing", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");

    const worker = makeFakeWorker({ turnId: "turn-cmp-dup", blocksThisTurn: 0 });
    __putLiveWorkerForTest(worker.agentName, worker as never);

    await handleEvent(
      worker as never,
      {
        type: "compaction-boundary",
        sessionId: "sess-cmp-1",
        preTokens: 200,
        postTokens: 40,
        durationMs: 10,
      } as never,
    );
    await handleEvent(
      worker as never,
      {
        type: "compaction-boundary",
        sessionId: "sess-cmp-1",
        preTokens: 60,
        postTokens: 30,
        durationMs: 8,
      } as never,
    );

    __deleteLiveWorkerForTest(worker.agentName);

    const rows = await getDb()
      .select()
      .from(schema.blocks)
      .where(eq(schema.blocks.turnId, "turn-cmp-dup"));
    expect(rows.filter((r) => r.kind === "compaction").length).toBe(2);
    // Both markers bumped the counter (multiple compactions in one long turn
    // are legitimate; each deserves a divider).
    expect(worker.blocksThisTurn).toBe(2);
  });
});

describe("lifecycle.handleEvent on `compacting-status` IPC (FRI-156 §F / AC8)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs worker.compact.result with result+error on a FAILED closing frame (AC8 — error not dropped)", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {});

    const worker = makeFakeWorker({ turnId: "turn-cmp-fail" });
    __putLiveWorkerForTest(worker.agentName, worker as never);

    await handleEvent(
      worker as never,
      {
        type: "compacting-status",
        sessionId: "sess-cmp-1",
        phase: "done",
        result: "failed",
        error: "ran out of room",
      } as never,
    );

    __deleteLiveWorkerForTest(worker.agentName);

    // The cross-boundary path (worker → lifecycle → daemon.jsonl) logs the
    // failure reason at warn — it is dropped from the wire CompactingEvent.
    expect(logSpy).toHaveBeenCalledWith("warn", "worker.compact.result", {
      agent: worker.agentName,
      turn_id: worker.turnId,
      result: "failed",
      error: "ran out of room",
    });
  });

  it("logs worker.compact.result at info on a SUCCESSFUL closing frame (no error field)", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {});

    const worker = makeFakeWorker({ turnId: "turn-cmp-ok" });
    __putLiveWorkerForTest(worker.agentName, worker as never);

    await handleEvent(
      worker as never,
      {
        type: "compacting-status",
        sessionId: "sess-cmp-1",
        phase: "done",
        result: "success",
      } as never,
    );

    __deleteLiveWorkerForTest(worker.agentName);

    expect(logSpy).toHaveBeenCalledWith("info", "worker.compact.result", {
      agent: worker.agentName,
      turn_id: worker.turnId,
      result: "success",
    });
  });

  it("does NOT log worker.compact.result on the 'start' frame (only the closing frame)", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {});

    const worker = makeFakeWorker({ turnId: "turn-cmp-start" });
    __putLiveWorkerForTest(worker.agentName, worker as never);

    await handleEvent(
      worker as never,
      { type: "compacting-status", sessionId: "sess-cmp-1", phase: "start" } as never,
    );

    __deleteLiveWorkerForTest(worker.agentName);

    expect(logSpy.mock.calls.some((c) => c[1] === "worker.compact.result")).toBe(false);
  });
});

describe("lifecycle.handleEvent on `compacting-status` IPC — durable compacting_since flag", () => {
  it("stamps agents.compacting_since on the 'start' frame (durable mirror of the SSE signal)", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    await registerWorkingAgent("cmp-agent");

    const worker = makeFakeWorker({ turnId: "turn-cmp-since-start" });
    __putLiveWorkerForTest(worker.agentName, worker as never);
    await handleEvent(
      worker as never,
      { type: "compacting-status", sessionId: "sess-cmp-1", phase: "start" } as never,
    );
    __deleteLiveWorkerForTest(worker.agentName);

    const [row] = await getDb()
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.name, "cmp-agent"));
    expect(row.compactingSince).toBeInstanceOf(Date);
  });

  it("clears agents.compacting_since to NULL on the 'done' frame", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    await registerWorkingAgent("cmp-agent", { compactingSince: new Date(Date.now() - 5000) });

    const worker = makeFakeWorker({ turnId: "turn-cmp-since-done" });
    __putLiveWorkerForTest(worker.agentName, worker as never);
    await handleEvent(
      worker as never,
      {
        type: "compacting-status",
        sessionId: "sess-cmp-1",
        phase: "done",
        result: "success",
      } as never,
    );
    __deleteLiveWorkerForTest(worker.agentName);

    const [row] = await getDb()
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.name, "cmp-agent"));
    expect(row.compactingSince).toBeNull();
  });

  it("CROSS-BOUNDARY: 'start' BOTH publishes the transient `compacting` SSE event AND stamps the durable column", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");
    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    await registerWorkingAgent("cmp-agent");
    const worker = makeFakeWorker({ turnId: "turn-cmp-both" });
    __putLiveWorkerForTest(worker.agentName, worker as never);
    await handleEvent(
      worker as never,
      { type: "compacting-status", sessionId: "sess-cmp-1", phase: "start" } as never,
    );
    __deleteLiveWorkerForTest(worker.agentName);
    unsub();

    // Transient half: the low-latency SSE signal still fires.
    expect(
      captured.some(
        (e) => e.type === "compacting" && e.phase === "start" && e.agent === "cmp-agent",
      ),
    ).toBe(true);
    // Durable half: the reconstructable column is stamped.
    const [row] = await getDb()
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.name, "cmp-agent"));
    expect(row.compactingSince).toBeInstanceOf(Date);
  });
});
