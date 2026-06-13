/**
 * Phase 4.11b — sendUserMessage LISTEN trigger tests.
 *
 * Pins the trigger contract:
 *   - Fires NOTIFY `friday_new_pending_block` on INSERT at
 *     status='pending' with the row's id as payload.
 *   - Does NOT fire on the daemon's UPDATE flip-back to
 *     'complete' / 'queued' (handler-reentry safety: trigger is
 *     AFTER INSERT only, not AFTER UPDATE).
 *   - Does NOT fire on INSERTs at any non-'pending' status
 *     (recordUserBlock writes 'complete' or 'queued' directly —
 *     those legacy paths must not re-enter the dispatch handler).
 *
 * The handler's full dispatch (agent register, prompt compose,
 * skill match, recall wrap, dispatchTurn) is exercised by the
 * existing chat-turn integration tests; this file pins the
 * trigger plumbing only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, getDb, schema, type TestDbHandle, newTestClient } from "@friday/shared";
import { eq } from "drizzle-orm";

// Static `vi.mock` (not doMock + resetModules) so @friday/shared's module-level
// Postgres pool isn't rebound mid-file. Mirrors resume-listener.test.ts — these
// stub out the heavy dispatch collaborators so `processPendingBlockRow` can run
// against the real scratch DB without forking a worker.
vi.mock("./registry.js", () => ({
  getAgent: vi.fn(),
  registerAgent: vi.fn(),
  workingDirectoryFor: vi.fn(async () => "/tmp/cwd"),
}));
vi.mock("./lifecycle.js", () => ({
  dispatchTurn: vi.fn(),
  peekLiveWorker: vi.fn(() => null),
}));
vi.mock("../prompts/build-dispatch-prompt.js", () => ({
  buildDispatchPrompt: vi.fn(async () => ({
    systemPrompt: "system-stub",
    body: "body-stub",
    allowedToolsOverride: undefined,
  })),
}));
vi.mock("../skills/match.js", () => ({
  matchSkillInvocation: vi.fn(() => null),
}));

// Handler-guard mocks (mirrors resume-listener.test.ts). Static `vi.mock` so
// `@friday/shared`'s module-level Postgres pool stays bound to the test DB —
// `resetModules` would spawn a second pool that leaks until the DB is dropped.
vi.mock("./registry.js", () => ({
  getAgent: vi.fn(),
  registerAgent: vi.fn(),
  workingDirectoryFor: vi.fn(async () => "/tmp/cwd"),
}));
vi.mock("./lifecycle.js", () => ({
  dispatchTurn: vi.fn(),
  peekLiveWorker: vi.fn(() => null),
}));
vi.mock("../prompts/build-dispatch-prompt.js", () => ({
  buildDispatchPrompt: vi.fn(async () => ({
    systemPrompt: "system-stub",
    body: "body-stub",
    allowedToolsOverride: undefined,
  })),
}));
vi.mock("../skills/match.js", () => ({
  matchSkillInvocation: vi.fn(() => null),
}));

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "dispatch_listener" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  vi.clearAllMocks();
});

async function insertBlock(id: string, status: string): Promise<void> {
  const db = getDb();
  await db.insert(schema.blocks).values({
    id,
    blockId: id,
    turnId: `t_${id}`,
    agentName: "test-agent",
    sessionId: "__pending__",
    messageId: null,
    blockIndex: 0,
    role: "user",
    kind: "text",
    source: "user_chat",
    contentJson: { text: "hello" },
    status,
    streaming: false,
    originMutationId: null,
    ts: new Date(),
  });
}

describe("Postgres trigger: friday_block_dispatch_notify_trigger", () => {
  it("fires NOTIFY on INSERT at status='pending' with the row id as payload", async () => {
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const received: Array<{ channel: string; payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ channel: msg.channel, payload: msg.payload ?? "" }),
      );
      await client.query("LISTEN friday_new_pending_block");

      await insertBlock("blk-dispatch-1", "pending");

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1);
          expect(received[0]!.channel).toBe("friday_new_pending_block");
          expect(received[0]!.payload).toBe("blk-dispatch-1");
        },
        { timeout: 5000, interval: 25 },
      );
    } finally {
      await client.end();
    }
  });

  it("does NOT fire on INSERT at status='complete' (legacy recordUserBlock path)", async () => {
    // The legacy `POST /api/chat/turn` writes 'complete' (or
    // 'queued') directly via `recordUserBlock`; those rows must
    // not re-enter the LISTEN handler.
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));
      await client.query("LISTEN friday_new_pending_block");

      await insertBlock("blk-dispatch-2", "complete");

      // negative-space: the trigger predicate excludes non-'pending' INSERTs —
      // a bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("does NOT fire on INSERT at status='queued' (legacy queued path)", async () => {
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));
      await client.query("LISTEN friday_new_pending_block");

      await insertBlock("blk-dispatch-3", "queued");

      // negative-space: the trigger predicate excludes non-'pending' INSERTs —
      // a bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("does NOT fire on UPDATE pending → complete (handler-reentry safety: AFTER INSERT only)", async () => {
    // The LISTEN handler ends with `UPDATE blocks SET
    // status='complete'`. If the trigger fired on UPDATEs too,
    // we'd loop (notify → handler → flip → notify → ...). The
    // trigger is AFTER INSERT only.
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      await insertBlock("blk-dispatch-4", "pending");
      await client.query("LISTEN friday_new_pending_block");
      // negative-space: drain the pending-INSERT NOTIFY before attaching
      // our handler so the assertion below isn't polluted.
      await new Promise((r) => setTimeout(r, 250));

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));

      const db = getDb();
      await db.update(schema.blocks).set({ status: "complete" });

      // negative-space: trigger is AFTER INSERT only — UPDATEs don't fire.
      // A bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("does NOT fire on UPDATE pending → queued (worker-mid-turn path)", async () => {
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      await insertBlock("blk-dispatch-5", "pending");
      await client.query("LISTEN friday_new_pending_block");
      // negative-space: drain the pending-INSERT NOTIFY before attaching
      // our handler so the assertion below isn't polluted.
      await new Promise((r) => setTimeout(r, 250));

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));

      const db = getDb();
      await db.update(schema.blocks).set({ status: "queued" });

      // negative-space: trigger is AFTER INSERT only — UPDATEs don't fire.
      // A bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});

/**
 * FRI-156 follow-up (SEV-0): processPendingBlockRow dispatch-mode routing.
 *
 * The silent-vanish chain: a user_chat message to a `scheduled`-type agent was
 * dispatched `one-shot` (mode keyed on agent TYPE). One-shot short-circuits the
 * worker loop after the first `query()`; the resumed stale scheduled session
 * returns zero content → blocksThisTurn===0 → zero-blocked → worker exits 0,
 * nothing renders, the user's message disappears.
 *
 * The fix gates `mode` on the block SOURCE (this handler only ever runs for
 * `user_chat`-origin blocks — an INTERACTIVE turn that must get a reply), so it
 * always dispatches `long-lived`, regardless of agent type. The autonomous
 * schedule fire (scheduler/spawn.ts) never reaches this handler and keeps
 * one-shot. Also pins that the dispatch carries `turnSource: "user_chat"` so the
 * downstream zero-block safety net (turn-state-machine) can emit a visible
 * notice if the long-lived turn still produces nothing.
 */
describe("processPendingBlockRow dispatch-mode routing (FRI-156 SEV-0)", () => {
  async function insertPendingUserBlock(blockId: string): Promise<void> {
    const db = getDb();
    await db.insert(schema.blocks).values({
      id: blockId,
      blockId,
      turnId: `turn-${blockId}`,
      agentName: "sched-agent",
      sessionId: "__pending__",
      messageId: null,
      blockIndex: 0,
      role: "user",
      kind: "text",
      source: "user_chat",
      contentJson: { text: "hi scheduled agent" },
      status: "pending",
      streaming: false,
      originMutationId: null,
      ts: new Date(),
    });
  }

  function scheduledAgent(name: string) {
    return {
      name,
      type: "scheduled" as const,
      status: "idle" as const,
      taskPrompt: "do the thing",
      paused: false,
      sessionId: "stale-session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function orchestratorAgent(name: string) {
    return {
      name,
      type: "orchestrator" as const,
      status: "idle" as const,
      sessionId: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  it("dispatches a user_chat → SCHEDULED-type agent as long-lived (not one-shot) so it replies", async () => {
    await insertPendingUserBlock("blk-sched-1");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processPendingBlockRow } = await import("./dispatch-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(scheduledAgent("sched-agent"));
    vi.mocked(lifecycle.peekLiveWorker).mockReturnValue(null);

    await _processPendingBlockRow("blk-sched-1");

    expect(lifecycle.dispatchTurn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(lifecycle.dispatchTurn).mock.calls[0]![0];
    // The bug was `mode: "one-shot"` for a scheduled agent. The fix: a
    // user_chat-origin turn is always long-lived so the agent actually replies.
    expect(call.options.mode).toBe("long-lived");
    // The origin source is threaded so the zero-block safety net can fire.
    expect(call.options.turnSource).toBe("user_chat");
  });

  it("dispatches a user_chat → orchestrator agent as long-lived (unchanged)", async () => {
    const db = getDb();
    await db.insert(schema.blocks).values({
      id: "blk-orch-1",
      blockId: "blk-orch-1",
      turnId: "turn-blk-orch-1",
      agentName: "sched-agent",
      sessionId: "__pending__",
      messageId: null,
      blockIndex: 0,
      role: "user",
      kind: "text",
      source: "user_chat",
      contentJson: { text: "hi" },
      status: "pending",
      streaming: false,
      originMutationId: null,
      ts: new Date(),
    });
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processPendingBlockRow } = await import("./dispatch-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(orchestratorAgent("sched-agent"));
    vi.mocked(lifecycle.peekLiveWorker).mockReturnValue(null);

    await _processPendingBlockRow("blk-orch-1");

    expect(lifecycle.dispatchTurn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(lifecycle.dispatchTurn).mock.calls[0]![0];
    expect(call.options.mode).toBe("long-lived");
    expect(call.options.turnSource).toBe("user_chat");
  });
});

describe("processPendingBlockRow — claim guard (no double dispatch)", () => {
  function stubAgent(name: string): {
    name: string;
    type: "orchestrator";
    status: "idle";
    sessionId: string | null;
    createdAt: string;
    updatedAt: string;
  } {
    return {
      name,
      type: "orchestrator",
      status: "idle",
      sessionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async function getStatus(id: string): Promise<string | null> {
    const db = getDb();
    const rows = await db
      .select({ status: schema.blocks.status })
      .from(schema.blocks)
      .where(eq(schema.blocks.blockId, id))
      .limit(1);
    return rows[0]?.status ?? null;
  }

  it("two interleaved callers that BOTH pass the pending read dispatch exactly once", async () => {
    // The HIGH finding: `processPendingBlockRow` short-circuits on a non-atomic
    // line-69 read (`status !== 'pending'`). Two callers (e.g. the reaper's
    // tick racing the listener's NOTIFY / boot scan over the SAME
    // `status='pending' AND role='user'` row) can BOTH pass that read while the
    // row is still pending. The claiming `UPDATE … WHERE status='pending'` then
    // lets exactly ONE change the row; dispatch must be gated on that UPDATE's
    // rowCount so only the winner calls `dispatchTurn` (which has no turnId
    // dedupe → a second call would be a duplicate turn / duplicate queued
    // prompt). This test interleaves two REAL invocations that both start while
    // the row is pending and asserts a single dispatch.
    await insertBlock("blk-claim-race", "pending");

    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const buildPrompt = await import("../prompts/build-dispatch-prompt.js");
    const { processPendingBlockRow } = await import("./dispatch-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(
      stubAgent("test-agent") as unknown as Awaited<ReturnType<typeof registry.getAgent>>,
    );
    vi.mocked(lifecycle.peekLiveWorker).mockReturnValue(null);

    // Barrier: both invocations must reach `buildDispatchPrompt` (which is AFTER
    // the line-69 `status !== 'pending'` read and BEFORE the claiming UPDATE)
    // before EITHER is allowed to proceed. This makes the interleave
    // DETERMINISTIC — it guarantees both callers passed the pending read while
    // the row was still pending, so the rowCount claim gate (not the line-69
    // read) is what arbitrates. Without this, the two calls could serialize and
    // the second would short-circuit on the read instead, not exercising the
    // guard the HIGH finding is about.
    let arrived = 0;
    let releaseBarrier!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    vi.mocked(buildPrompt.buildDispatchPrompt).mockImplementation(async () => {
      arrived += 1;
      if (arrived === 2) releaseBarrier();
      await bothArrived;
      return { systemPrompt: "system-stub", body: "body-stub", allowedToolsOverride: undefined };
    });

    await Promise.all([
      processPendingBlockRow("blk-claim-race"),
      processPendingBlockRow("blk-claim-race"),
    ]);

    // Both passed the pending read; exactly one winner's UPDATE matched the row
    // and dispatched, the loser's matched zero rows and returned before
    // `dispatchTurn`.
    expect(arrived).toBe(2);
    expect(lifecycle.dispatchTurn).toHaveBeenCalledTimes(1);
    // Row was claimed once, flipped out of 'pending'.
    expect(await getStatus("blk-claim-race")).toBe("complete");
  });

  it("normal single-caller path still dispatches (rowCount-1 → proceed)", async () => {
    // Regression guard for the rowCount gate: the common NOTIFY / boot-scan
    // single-caller case must be unaffected — one call, one dispatch.
    await insertBlock("blk-claim-single", "pending");

    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { processPendingBlockRow } = await import("./dispatch-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(
      stubAgent("test-agent") as unknown as Awaited<ReturnType<typeof registry.getAgent>>,
    );
    vi.mocked(lifecycle.peekLiveWorker).mockReturnValue(null);

    await processPendingBlockRow("blk-claim-single");

    expect(lifecycle.dispatchTurn).toHaveBeenCalledTimes(1);
    expect(await getStatus("blk-claim-single")).toBe("complete");
  });
});
