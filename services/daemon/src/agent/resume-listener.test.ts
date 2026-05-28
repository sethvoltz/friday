/**
 * FRI-123 — block resumeTurn LISTEN trigger + handler-guard tests.
 *
 * Trigger contract (mirrors abort-listener.test.ts shape):
 *   - Fires NOTIFY `friday_resume_requested` on UPDATE that
 *     transitions blocks.status TO 'resume_requested'.
 *   - Does NOT fire on the daemon's flip-back UPDATE to 'complete'
 *     (handler-reentry safety).
 *   - Does NOT fire on common lifecycle UPDATEs that don't touch
 *     status (other-field bumps must not spam the channel).
 *   - AFTER UPDATE only — INSERTs at 'resume_requested' don't fire.
 *
 * Handler guards exercised separately via `_processResumeRequestedRow`
 * with `vi.mock`-hoisted stubs for the lifecycle/registry deps so the
 * test doesn't fork workers:
 *   - status moved on → no-op (idempotent re-run after flip-back).
 *   - row deleted → no-op.
 *   - no-agent guard → flips back without dispatching.
 *   - in-flight-turn guard → flips back without dispatching.
 *   - peekLiveWorker working → flips back without dispatching.
 *   - happy path → dispatches re-using the original turn_id, flips back.
 *
 * Static `vi.mock` is used (not `vi.doMock` + `vi.resetModules`) so
 * `@friday/shared`'s module-level Postgres pool doesn't get re-bound
 * mid-file — `resetModules` would otherwise spawn a second pool that
 * leaks until the test DB is dropped, surfacing as a FATAL `57P01`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";
import { eq } from "drizzle-orm";
import pgPkg from "pg";

vi.mock("./registry.js", () => ({
  getAgent: vi.fn(),
  workingDirectoryFor: vi.fn(async () => "/tmp/cwd"),
}));
vi.mock("./lifecycle.js", () => ({
  dispatchTurn: vi.fn(),
  findAgentByTurnId: vi.fn(() => null),
  peekLiveWorker: vi.fn(() => null),
}));
vi.mock("../prompts/build-dispatch-prompt.js", () => ({
  buildDispatchPrompt: vi.fn(async () => ({
    systemPrompt: "system-stub",
    body: "body-stub",
    allowedToolsOverride: undefined,
  })),
}));

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "resume_listener" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  vi.clearAllMocks();
});

async function insertUserBlock(blockId: string, status: string = "complete"): Promise<void> {
  const db = getDb();
  await db.insert(schema.blocks).values({
    blockId,
    turnId: `turn-${blockId}`,
    agentName: "test-agent",
    sessionId: "test-session",
    messageId: null,
    blockIndex: 0,
    role: "user",
    kind: "text",
    source: "user_chat",
    contentJson: { text: "the original prompt" },
    status,
    streaming: false,
    originMutationId: null,
    ts: new Date(),
    lastEventSeq: 0,
  });
}

describe("Postgres trigger: friday_block_resume_notify_trigger", () => {
  it("fires NOTIFY when status transitions to 'resume_requested' and carries block_id as payload", async () => {
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      await insertUserBlock("blk-resume-1");

      const received: Array<{ channel: string; payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ channel: msg.channel, payload: msg.payload ?? "" }),
      );
      await client.query("LISTEN friday_resume_requested");

      const db = getDb();
      await db.update(schema.blocks).set({ status: "resume_requested" });

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1);
          expect(received[0]!.channel).toBe("friday_resume_requested");
          expect(received[0]!.payload).toBe("blk-resume-1");
        },
        { timeout: 5000, interval: 25 },
      );
    } finally {
      await client.end();
    }
  });

  it("does NOT fire NOTIFY when the daemon flips the row back to 'complete' (handler-reentry safety)", async () => {
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      await insertUserBlock("blk-resume-2", "resume_requested");
      await client.query("LISTEN friday_resume_requested");
      // negative-space: drain any buffered notification before attaching
      // our handler so the assertion below isn't polluted.
      await new Promise((r) => setTimeout(r, 250));

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));

      const db = getDb();
      await db.update(schema.blocks).set({ status: "complete" });

      // negative-space: trigger predicate excludes flips to 'complete' —
      // a bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("does NOT fire NOTIFY on common lifecycle transitions (other-field UPDATEs)", async () => {
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      await insertUserBlock("blk-resume-3");

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));
      await client.query("LISTEN friday_resume_requested");

      const db = getDb();
      await db.update(schema.blocks).set({ lastEventSeq: 42 });
      await db.update(schema.blocks).set({ blockIndex: 1 });

      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("AFTER UPDATE only — INSERT at status='resume_requested' doesn't fire", async () => {
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));
      await client.query("LISTEN friday_resume_requested");

      await insertUserBlock("blk-resume-insert", "resume_requested");

      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});

describe("processResumeRequestedRow handler guards", () => {
  async function getStatus(blockId: string): Promise<string | null> {
    const db = getDb();
    const rows = await db
      .select({ status: schema.blocks.status })
      .from(schema.blocks)
      .where(eq(schema.blocks.blockId, blockId));
    return rows[0]?.status ?? null;
  }

  function stubAgent(name: string): {
    name: string;
    type: "orchestrator";
    status: "idle";
    createdAt: string;
    updatedAt: string;
  } {
    return {
      name,
      type: "orchestrator",
      status: "idle",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  it("no-op when the row was deleted between NOTIFY and handler", async () => {
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(stubAgent("test-agent"));
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue(null);

    await _processResumeRequestedRow("blk-missing");
    expect(lifecycle.dispatchTurn).not.toHaveBeenCalled();
  });

  it("no-op when status has already moved on (idempotent re-run after flip-back)", async () => {
    await insertUserBlock("blk-resume-idem", "complete");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    await _processResumeRequestedRow("blk-resume-idem");
    expect(lifecycle.dispatchTurn).not.toHaveBeenCalled();
    expect(await getStatus("blk-resume-idem")).toBe("complete");
  });

  it("flips back without dispatching when the agent doesn't exist (no-agent guard)", async () => {
    await insertUserBlock("blk-resume-noagent", "resume_requested");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(null);
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue(null);

    await _processResumeRequestedRow("blk-resume-noagent");
    expect(lifecycle.dispatchTurn).not.toHaveBeenCalled();
    expect(await getStatus("blk-resume-noagent")).toBe("complete");
  });

  it("flips back without dispatching when a turn is already in flight for the agent", async () => {
    await insertUserBlock("blk-resume-inflight", "resume_requested");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(stubAgent("test-agent"));
    // pretend a turn is already in flight for this turnId
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue("test-agent");

    await _processResumeRequestedRow("blk-resume-inflight");
    expect(lifecycle.dispatchTurn).not.toHaveBeenCalled();
    expect(await getStatus("blk-resume-inflight")).toBe("complete");
  });

  it("flips back without dispatching when peekLiveWorker reports the agent as working", async () => {
    await insertUserBlock("blk-resume-busy", "resume_requested");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(stubAgent("test-agent"));
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue(null);
    vi.mocked(lifecycle.peekLiveWorker).mockReturnValue({
      status: "working",
    } as ReturnType<typeof lifecycle.peekLiveWorker>);

    await _processResumeRequestedRow("blk-resume-busy");
    expect(lifecycle.dispatchTurn).not.toHaveBeenCalled();
    expect(await getStatus("blk-resume-busy")).toBe("complete");
  });

  it("happy path — dispatches via dispatchTurn re-using the original turn_id, then flips back", async () => {
    await insertUserBlock("blk-resume-ok", "resume_requested");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(stubAgent("test-agent"));
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue(null);
    vi.mocked(lifecycle.peekLiveWorker).mockReturnValue({
      status: "idle",
    } as ReturnType<typeof lifecycle.peekLiveWorker>);

    await _processResumeRequestedRow("blk-resume-ok");
    expect(lifecycle.dispatchTurn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(lifecycle.dispatchTurn).mock.calls[0]?.[0] as {
      agentName: string;
      options: { turnId: string; systemPrompt: string; prompt: string };
    };
    expect(call.agentName).toBe("test-agent");
    // FRI-12 contract: re-use the existing turn_id so the retry's
    // content blocks visually group with the original error bubble.
    expect(call.options.turnId).toBe("turn-blk-resume-ok");
    expect(call.options.systemPrompt).toBe("system-stub");
    expect(call.options.prompt).toBe("body-stub");
    expect(await getStatus("blk-resume-ok")).toBe("complete");
  });
});
