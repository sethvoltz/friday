/**
 * Chat-store regression tests (post-mortem after the catastrophic chat
 * regressions of 2026-05-13). The bugs that landed in production were
 * all in code paths within this module:
 *
 *   - `loadAgentTurns` hit `/api/agents/:name/turns` while the daemon
 *     only wrote to the blocks table → reload showed nothing.
 *   - `confirmPending` would create duplicate-id rows when the daemon's
 *     SSE `block_complete` arrived before the POST /api/chat/turn
 *     response.
 *   - Queue-synthesized bubbles were wiped by the live-fetch
 *     overwrite.
 *
 * Each test below targets one specific behavior. Mocks the network
 * boundary (`fetchWithTimeout` / `fetch`) and the send-queue singleton;
 * leaves the Svelte $state machinery real so the assertions exercise
 * the same code path the browser runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `fetchWithTimeout` is the network boundary the chat store uses. Mock
// it at module level so every import gets the stubbed version. We swap
// the implementation per-test via `mockFetchWithTimeout`.
const mockFetchWithTimeout = vi.fn<
  (url: string, opts?: { timeoutMs?: number }) => Promise<Response>
>();
vi.mock("$lib/util/fetch-with-timeout", () => ({
  fetchWithTimeout: mockFetchWithTimeout,
}));

// The chat store reads / writes localStorage via these helpers. We
// stub them so tests start from a clean slate and don't pollute the
// jsdom store between cases.
const mockLoadJSON = vi.fn();
const mockSaveJSON = vi.fn();
vi.mock("$lib/stores/persistent", () => ({
  loadJSON: mockLoadJSON,
  saveJSON: mockSaveJSON,
  KEYS: { transcript: (agent: string) => `transcript:${agent}` },
}));

// `sendQueue` is a singleton with internal $state. We stub the methods
// the chat store reaches into so we can drive the queue from tests.
const mockForAgent = vi.fn<(agent: string) => unknown[]>(() => []);
vi.mock("$lib/stores/send-queue.svelte", () => ({
  sendQueue: {
    forAgent: mockForAgent,
    enqueue: vi.fn(),
    remove: vi.fn(),
    flush: vi.fn(),
  },
}));

// `initialPageSize` returns a fixed page size for predictable URL
// assertions.
vi.mock("$lib/util/page-size", () => ({
  initialPageSize: () => 25,
}));

function makeResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  mockFetchWithTimeout.mockReset();
  mockLoadJSON.mockReset();
  mockSaveJSON.mockReset();
  mockForAgent.mockReset();
  mockLoadJSON.mockReturnValue([]);
  mockForAgent.mockReturnValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loadAgentTurns", () => {
  it("fetches /api/agents/:name/blocks (NOT /turns)", async () => {
    // This is the load-bearing assertion of the regression-prevention
    // test. Before the WS-1 cleanup the chat store called /turns; the
    // daemon stopped writing to that table and every reload returned
    // empty. The endpoint the dashboard hits MUST be /blocks.
    mockFetchWithTimeout.mockResolvedValue(
      makeResponse({ blocks: [], lastEventSeq: 0 }),
    );
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.loadAgentTurns("friday");
    expect(mockFetchWithTimeout).toHaveBeenCalled();
    const calledUrls = mockFetchWithTimeout.mock.calls.map((c) => c[0]);
    const blocksCall = calledUrls.find((u) => u.includes("/blocks"));
    expect(
      blocksCall,
      `expected a /blocks call; saw: ${calledUrls.join(", ")}`,
    ).toBeDefined();
    expect(blocksCall).toMatch(/\/api\/agents\/friday\/blocks/);
    // Must NOT regress to /turns — that endpoint reads from a table
    // the daemon doesn't write to post-WS-1.
    const turnsCall = calledUrls.find((u) =>
      /\/api\/agents\/[^/]+\/turns(?:\?|$)/.test(u),
    );
    expect(turnsCall, "regression: chat store is calling /turns").toBeUndefined();
  });

  it("seeds oldestBlockId from the response's oldest block_id", async () => {
    mockFetchWithTimeout.mockResolvedValue(
      makeResponse({
        blocks: [
          { id: 3, blockId: "blk-c", turnId: "t-c", role: "assistant", kind: "text", contentJson: '{"text":"c"}', status: "complete", ts: 300, agentName: "friday", sessionId: "s", messageId: null, blockIndex: 0, source: null, lastEventSeq: 3 },
          { id: 1, blockId: "blk-a", turnId: "t-a", role: "user", kind: "text", contentJson: '{"text":"a"}', status: "complete", ts: 100, agentName: "friday", sessionId: "s", messageId: null, blockIndex: 0, source: null, lastEventSeq: 1 },
          { id: 2, blockId: "blk-b", turnId: "t-b", role: "assistant", kind: "text", contentJson: '{"text":"b"}', status: "complete", ts: 200, agentName: "friday", sessionId: "s", messageId: null, blockIndex: 0, source: null, lastEventSeq: 2 },
        ],
        lastEventSeq: 3,
      }),
    );
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.loadAgentTurns("friday");
    // `oldestBlockCursor` picks the smallest id; `blk-a` (id=1).
    expect(chat.oldestBlockId).toBe("blk-a");
  });

  it("preserves queue-synth bubbles across the live-fetch overwrite", async () => {
    // The queue-synth loop pushes a placeholder bubble for any
    // queued-but-unsent message. Before the regression-fix, the
    // synth ran BEFORE the live fetch and got wiped by
    // `this.messages = parseBlocks(...)`. The synth bubbles must
    // survive the overwrite — that's the only way a queued message
    // remains visible across reload.
    mockForAgent.mockReturnValue([
      {
        id: "q_abc",
        agent: "friday",
        text: "queued draft",
        status: "queued",
        attempts: 0,
        createdAt: 1000,
      },
    ]);
    mockFetchWithTimeout.mockResolvedValue(
      makeResponse({
        blocks: [
          { id: 1, blockId: "blk-1", turnId: "t-1", role: "user", kind: "text", contentJson: '{"text":"old"}', status: "complete", ts: 100, agentName: "friday", sessionId: "s", messageId: null, blockIndex: 0, source: null, lastEventSeq: 1 },
        ],
        lastEventSeq: 1,
      }),
    );
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.loadAgentTurns("friday");
    const queueSynth = chat.messages.find((m) => m.queueId === "q_abc");
    expect(
      queueSynth,
      "queue-synth bubble must survive the live-fetch overwrite",
    ).toBeDefined();
    expect(queueSynth?.text).toBe("queued draft");
  });
});

describe("loadOlderTurns", () => {
  it("uses oldestBlockId as the `before` query param", async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        // Initial load
        makeResponse({
          blocks: [
            { id: 5, blockId: "blk-5", turnId: "t-5", role: "user", kind: "text", contentJson: '{"text":"recent"}', status: "complete", ts: 500, agentName: "friday", sessionId: "s", messageId: null, blockIndex: 0, source: null, lastEventSeq: 5 },
          ],
          lastEventSeq: 5,
        }),
      )
      .mockResolvedValueOnce(
        // Agent-status probe in `loadAgentTurns`'s F step
        makeResponse({ status: "idle" }),
      )
      .mockResolvedValueOnce(
        // The actual `loadOlderTurns` call
        makeResponse({ blocks: [], lastEventSeq: 0 }),
      );
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.loadAgentTurns("friday");
    expect(chat.oldestBlockId).toBe("blk-5");
    await chat.loadOlderTurns();
    const olderCall = mockFetchWithTimeout.mock.calls.find((c) =>
      c[0].includes("before="),
    );
    expect(olderCall, "loadOlderTurns must use a `before=` cursor").toBeDefined();
    expect(olderCall![0]).toMatch(/before=blk-5/);
  });

  it("sets reachedOldest=true on an empty response", async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        makeResponse({
          blocks: [
            { id: 1, blockId: "blk-1", turnId: "t-1", role: "user", kind: "text", contentJson: '{"text":"a"}', status: "complete", ts: 100, agentName: "friday", sessionId: "s", messageId: null, blockIndex: 0, source: null, lastEventSeq: 1 },
          ],
          lastEventSeq: 1,
        }),
      )
      .mockResolvedValueOnce(makeResponse({ status: "idle" }))
      .mockResolvedValueOnce(makeResponse({ blocks: [], lastEventSeq: 0 }));
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.loadAgentTurns("friday");
    expect(chat.reachedOldest).toBe(false);
    // Use real timers for the MIN_LOADING_MS sleep — fake timers
    // would deadlock the await on setTimeout. The test still
    // resolves in ~400ms which is fine.
    await chat.loadOlderTurns();
    expect(chat.reachedOldest).toBe(true);
  });
});

describe("confirmPending", () => {
  it("re-keys the optimistic bubble when no SSE bubble exists yet", async () => {
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    const pendingId = chat.addUser("hello", { queueId: "q_xyz" });
    expect(chat.messages.length).toBe(1);
    expect(chat.messages[0]!.id).toBe(pendingId);
    expect(chat.messages[0]!.pending).toBe(true);
    chat.confirmPending("q_xyz", "turn-123");
    expect(chat.messages.length).toBe(1);
    expect(chat.messages[0]!.id).toBe("user_turn-123");
    expect(chat.messages[0]!.pending).toBe(false);
    expect(chat.messages[0]!.queueId).toBeUndefined();
    expect(chat.messages[0]!.turnId).toBe("turn-123");
  });

  it("drops the optimistic bubble when the SSE block_complete arrived first", async () => {
    // The race the daemon-side fix (E) eliminates and this dedup (C)
    // defends against. Reproduce: push the optimistic, then simulate
    // the SSE handler creating a user_<turnId> bubble *before* the
    // POST response arrives, then call confirmPending. The result
    // should be a single bubble (the SSE-pushed one), not two with
    // the same id.
    const { ChatState, userBlockIdForTurn } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    chat.addUser("hello", { queueId: "q_race" });
    // Simulate SSE arriving first: handler pushes a canonical bubble.
    chat.applyEvent({
      v: 1,
      type: "block_complete",
      turn_id: "turn-race",
      agent: "friday",
      block_id: "blk-race",
      kind: "text",
      role: "user",
      content_json: '{"text":"hello"}',
      status: "complete",
      ts: 1000,
      seq: 1,
    } as Parameters<typeof chat.applyEvent>[0]);
    // Two bubbles right now: pending_X + user_turn-race.
    expect(chat.messages.length).toBe(2);
    // POST returns, confirmPending fires. Must collapse to one bubble.
    chat.confirmPending("q_race", "turn-race");
    expect(chat.messages.length).toBe(1);
    expect(chat.messages[0]!.id).toBe(userBlockIdForTurn("turn-race"));
    // The remaining bubble is the SSE-pushed one (no queueId).
    expect(chat.messages[0]!.queueId).toBeUndefined();
  });
});

describe("reload-mid-turn replay → SSE resumption", () => {
  it("preserves streaming status on assistant blocks so block_delta keeps appending", async () => {
    // Reproduces the exact symptom of "hard refresh shows the bubble
    // but never streams." Before the fix `parseBlocks` collapsed every
    // status into `complete`, and `handleBlockDelta` rejects deltas
    // whose target bubble isn't `streaming`. Result: a frozen replay
    // with no live continuation.
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        makeResponse({
          blocks: [
            { id: 1, blockId: "blk-asst-live", turnId: "turn-live", role: "assistant", kind: "text", contentJson: '{"text":"partial "}', status: "streaming", ts: 100, agentName: "friday", sessionId: "s", messageId: null, blockIndex: 0, source: null, lastEventSeq: 1 },
          ],
          lastEventSeq: 1,
        }),
      )
      .mockResolvedValueOnce(makeResponse({ status: "working" }));
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.loadAgentTurns("friday");

    const asst = chat.messages.find((m) => m.id === "b_blk-asst-live");
    expect(asst, "assistant block should be in messages after reload").toBeDefined();
    // Load-bearing: the status must be `streaming`, not `complete`,
    // otherwise the next block_delta drops on the floor.
    expect(asst?.status).toBe("streaming");

    // Now simulate the SSE block_delta the daemon emits to continue
    // filling this block. The text must append onto the existing
    // partial content.
    chat.applyEvent({
      v: 1,
      type: "block_delta",
      block_id: "blk-asst-live",
      turn_id: "turn-live",
      agent: "friday",
      delta: { text: "continuation" },
      seq: 2,
      ts: 110,
    } as Parameters<typeof chat.applyEvent>[0]);
    const after = chat.messages.find((m) => m.id === "b_blk-asst-live");
    expect(after?.text).toBe("partial continuation");
  });

  it("preserves running status on thinking blocks so block_delta keeps appending", async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        makeResponse({
          blocks: [
            { id: 1, blockId: "blk-think-live", turnId: "turn-think", role: "assistant", kind: "thinking", contentJson: '{"text":"thought so far "}', status: "streaming", ts: 100, agentName: "friday", sessionId: "s", messageId: null, blockIndex: 0, source: null, lastEventSeq: 1 },
          ],
          lastEventSeq: 1,
        }),
      )
      .mockResolvedValueOnce(makeResponse({ status: "working" }));
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.loadAgentTurns("friday");

    const think = chat.messages.find((m) => m.id === "th_blk-think-live");
    expect(think?.status).toBe("running");

    chat.applyEvent({
      v: 1,
      type: "block_delta",
      block_id: "blk-think-live",
      turn_id: "turn-think",
      agent: "friday",
      delta: { text: "more" },
      seq: 2,
      ts: 110,
    } as Parameters<typeof chat.applyEvent>[0]);
    const after = chat.messages.find((m) => m.id === "th_blk-think-live");
    expect(after?.text).toBe("thought so far more");
  });
});

describe("inflight-state probe on reload", () => {
  it("sets inflightTurnId when the agent status is 'working' and a streaming block exists", async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        makeResponse({
          blocks: [
            { id: 1, blockId: "blk-user", turnId: "turn-flying", role: "user", kind: "text", contentJson: '{"text":"go"}', status: "complete", ts: 100, agentName: "friday", sessionId: "s", messageId: null, blockIndex: 0, source: null, lastEventSeq: 1 },
            { id: 2, blockId: "blk-asst", turnId: "turn-flying", role: "assistant", kind: "text", contentJson: '{"text":"work"}', status: "streaming", ts: 110, agentName: "friday", sessionId: "s", messageId: null, blockIndex: 1, source: null, lastEventSeq: 2 },
          ],
          lastEventSeq: 2,
        }),
      )
      .mockResolvedValueOnce(makeResponse({ status: "working" }));
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.loadAgentTurns("friday");
    expect(chat.inflightTurnId).toBe("turn-flying");
  });

  it("leaves inflightTurnId null when the agent status is 'idle'", async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        makeResponse({
          blocks: [
            { id: 1, blockId: "blk-done", turnId: "turn-old", role: "assistant", kind: "text", contentJson: '{"text":"prev"}', status: "complete", ts: 100, agentName: "friday", sessionId: "s", messageId: null, blockIndex: 0, source: null, lastEventSeq: 1 },
          ],
          lastEventSeq: 1,
        }),
      )
      .mockResolvedValueOnce(makeResponse({ status: "idle" }));
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.loadAgentTurns("friday");
    expect(chat.inflightTurnId).toBeNull();
  });
});
