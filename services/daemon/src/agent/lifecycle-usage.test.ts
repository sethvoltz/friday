import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";

// Cross-boundary contract: when the worker emits `turn-complete` with a
// usage payload, the lifecycle handler must insert a row into the `usage`
// table whose columns map the SDK→protocol field names. The handler's
// insertUsage is fire-and-forget async (ADR-023); tests `settle()` a few
// ms after invocation before reading.

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_usage" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

function makeFakeWorker(): unknown {
  return {
    child: { send: () => {} },
    agentName: "test-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "turn-1",
    sessionId: "sess-1",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now() - 1000,
    spawnedAt: Date.now() - 5000,
    status: "working",
    nextPrompts: [],
    mode: "long-lived",
    lastExitStatus: "complete",
    completedAtLeastOnce: false,
  };
}

describe("lifecycle.handleEvent on turn-complete (cross-boundary)", () => {
  it("inserts a usage row whose columns map the SDK→protocol field names", async () => {
    const { handleEvent } = await import("./lifecycle.js");

    handleEvent(makeFakeWorker() as never, {
      type: "turn-complete",
      sessionId: "sess-1",
      usage: {
        input_tokens: 1234,
        output_tokens: 567,
        cache_creation_tokens: 89,
        cache_read_tokens: 4321,
        cost_usd: 0.1234,
      },
    });
    await vi.waitFor(
      async () => {
        const rows = await getDb().select().from(schema.usage);
        expect(rows.length).toBe(1);
        const row = rows[0];
        expect(row.costUsd).toBeCloseTo(0.1234);
        expect(row.inputTokens).toBe(1234);
        expect(row.outputTokens).toBe(567);
        expect(row.cacheCreationTokens).toBe(89);
        expect(row.cacheReadTokens).toBe(4321);
        expect(row.agentName).toBe("test-agent");
        expect(row.model).toBe("claude-opus-4-7");
      },
      { timeout: 5000, interval: 25 },
    );
  });

  it("inserts nothing when turn-complete carries no usage payload", async () => {
    const { handleEvent } = await import("./lifecycle.js");

    handleEvent(makeFakeWorker() as never, {
      type: "turn-complete",
      sessionId: "sess-1",
    });
    // negative-space: turn-complete without usage must not write a row.
    // handleEvent is fire-and-forget — give the async chain a bounded
    // real-time window to fire (so a regression would be visible) before
    // asserting nothing landed. vi.waitFor would resolve on the first tick.
    await new Promise((r) => setTimeout(r, 100));

    const rows = await getDb().select().from(schema.usage);
    expect(rows.length).toBe(0);
  });

  it("inserts nothing when there is no session id (neither worker nor event)", async () => {
    const { handleEvent } = await import("./lifecycle.js");

    const w = makeFakeWorker() as Record<string, unknown>;
    w.sessionId = undefined;

    handleEvent(w as never, {
      type: "turn-complete",
      sessionId: "",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        cost_usd: 0.01,
      },
    });
    // negative-space: missing session id must not write a row. Bounded
    // real-time wait gives the fire-and-forget path a chance to fire (so
    // a regression would be visible).
    await new Promise((r) => setTimeout(r, 100));

    const rows = await getDb().select().from(schema.usage);
    expect(rows.length).toBe(0);
  });
});
