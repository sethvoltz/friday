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

  it("seeds the per-agent SSE cursor from payload.lastEventSeq so replayed deltas don't double-append", async () => {
    // The companion to the daemon-side fix where `handleBlockDelta`
    // persists the accumulated text + advances the row's
    // `last_event_seq` on every delta. The cursor seed here is what
    // makes that fix safe: without it, the SSE replay would re-emit
    // every delta with seq <= row.lastEventSeq and `applyEvent` would
    // re-append the text — producing a duplicated message or
    // corrupted markdown.
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        makeResponse({
          blocks: [
            { id: 1, blockId: "blk-1", turnId: "t-1", role: "assistant", kind: "text", contentJson: '{"text":"partial "}', status: "streaming", ts: 100, agentName: "friday", sessionId: "s", messageId: null, blockIndex: 0, source: null, lastEventSeq: 42 },
          ],
          lastEventSeq: 42,
        }),
      )
      .mockResolvedValueOnce(makeResponse({ status: "working" }));
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.loadAgentTurns("friday");

    expect(chat.lastSeqByAgent["friday"]).toBe(42);

    // A replayed delta at seq=30 (older than the cursor) must be
    // dropped — its text is already in the row's content_json.
    chat.applyEvent({
      v: 1,
      type: "block_delta",
      block_id: "blk-1",
      turn_id: "t-1",
      agent: "friday",
      delta: { text: "REPLAY" },
      seq: 30,
      ts: 110,
    } as Parameters<typeof chat.applyEvent>[0]);
    expect(chat.messages[0]?.text, "replayed delta must not append").toBe(
      "partial ",
    );

    // A live delta at seq=50 (newer than cursor) applies normally.
    chat.applyEvent({
      v: 1,
      type: "block_delta",
      block_id: "blk-1",
      turn_id: "t-1",
      agent: "friday",
      delta: { text: "live" },
      seq: 50,
      ts: 120,
    } as Parameters<typeof chat.applyEvent>[0]);
    expect(chat.messages[0]?.text).toBe("partial live");
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

describe("jumpTo (/jump <date|term>)", () => {
  // jumpTo uses the raw `fetch` (not fetchWithTimeout) so we stub the
  // global. The mock is reinstalled per test so a stray vi.fn carry-over
  // doesn't cross-contaminate assertions.
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeBlock(overrides: Partial<{
    id: number;
    blockId: string;
    turnId: string;
    role: "user" | "assistant";
    kind: "text" | "thinking" | "tool_use" | "tool_result";
    text: string;
    ts: number;
    status: string;
  }> = {}) {
    const id = overrides.id ?? 1;
    return {
      id,
      blockId: overrides.blockId ?? `blk-${id}`,
      turnId: overrides.turnId ?? `t-${id}`,
      agentName: "friday",
      sessionId: "s",
      messageId: null,
      blockIndex: 0,
      role: overrides.role ?? "assistant",
      kind: overrides.kind ?? "text",
      source: null,
      contentJson: JSON.stringify({ text: overrides.text ?? `body-${id}` }),
      status: overrides.status ?? "complete",
      ts: overrides.ts ?? id * 100,
      lastEventSeq: id,
    };
  }

  it("merges results into existing messages instead of replacing them", async () => {
    // The bug this guards against: pre-fix, `jumpTo` did
    // `this.messages = parsed`, wiping the user's chat history. After
    // /jump the chat showed only the search-window blocks; the rest of
    // the conversation vanished until reload. Merge keeps both.
    mockFetch.mockResolvedValueOnce(
      makeResponse({
        blocks: [
          makeBlock({ id: 10, blockId: "blk-jump", turnId: "t-jump", role: "user", text: "found me", ts: 5000 }),
        ],
      }),
    );
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    // Pre-existing chat history that /jump must NOT clobber.
    chat.messages = [
      { id: "user_t-pre", role: "user", text: "earlier", status: "complete", ts: 1000 },
      { id: "b_blk-pre", role: "assistant", text: "earlier reply", status: "complete", ts: 1100, turnId: "t-pre" },
    ];
    await chat.jumpTo("friday", "found");
    const ids = chat.messages.map((m) => m.id);
    expect(ids).toContain("user_t-pre");
    expect(ids).toContain("b_blk-pre");
    // And the jumped-to block landed too.
    expect(ids).toContain("user_t-jump");
  });

  it("date jump: picks the earliest block on or after the target ts", async () => {
    // /jump today should land at the day's earliest block, not at the
    // tail of yesterday. parseJumpDate("today") returns midnight; the
    // server returns ~10 blocks before midnight + ~40 blocks after.
    // The scroll target must be the first AFTER-midnight block.
    const todayMidnight = (() => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    })();
    mockFetch.mockResolvedValueOnce(
      makeResponse({
        blocks: [
          // Two yesterday blocks (before midnight).
          makeBlock({ id: 1, blockId: "blk-y1", turnId: "t-y1", role: "user", ts: todayMidnight - 7_200_000 }),
          makeBlock({ id: 2, blockId: "blk-y2", turnId: "t-y1", role: "assistant", ts: todayMidnight - 7_100_000 }),
          // Today's earliest block — the scroll target.
          makeBlock({ id: 3, blockId: "blk-t1", turnId: "t-t1", role: "user", ts: todayMidnight + 1_000 }),
          makeBlock({ id: 4, blockId: "blk-t2", turnId: "t-t1", role: "assistant", ts: todayMidnight + 2_000 }),
        ],
      }),
    );
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.jumpTo("friday", "today");
    expect(chat.scrollTarget?.id).toBe("user_t-t1");
    // Date jumps don't pulse — that's reserved for term mode.
    expect(chat.highlightedMessageId).toBeNull();
  });

  it("date jump: uses around_ts query, not match", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({
        blocks: [makeBlock({ id: 1, role: "user", ts: 1000 })],
      }),
    );
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.jumpTo("friday", "today");
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain("around_ts=");
    expect(url).not.toContain("match=");
  });

  it("term jump: target id comes from the top-ranked raw block, not first by id", async () => {
    // matchBlocks returns ORDER BY rank, so blocks[0] is the best
    // match. parseBlocks then re-sorts by id ascending, which would
    // pick the *oldest* hit if we picked from the parsed list. The
    // target must be derived from the raw response order.
    mockFetch.mockResolvedValueOnce(
      makeResponse({
        blocks: [
          // Top-ranked: id=42 (later by id, but ranked first by FTS).
          makeBlock({ id: 42, blockId: "blk-best", turnId: "t-best", role: "assistant", text: "the unique token here", ts: 500 }),
          // Lower-ranked: id=10 (earlier by id).
          makeBlock({ id: 10, blockId: "blk-meh", turnId: "t-meh", role: "user", text: "vaguely the token", ts: 100 }),
        ],
      }),
    );
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.jumpTo("friday", "uniqueTermXYZ");
    expect(chat.scrollTarget?.id).toBe("b_blk-best");
    expect(chat.highlightedMessageId).toBe("b_blk-best");
  });

  it("term jump: toast carries the match count", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({
        blocks: [
          makeBlock({ id: 1, role: "user", text: "hit one" }),
          makeBlock({ id: 2, role: "assistant", text: "hit two" }),
          makeBlock({ id: 3, role: "user", text: "hit three" }),
        ],
      }),
    );
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.jumpTo("friday", "hit");
    expect(chat.toast?.message).toBe("3 matches");
    expect(chat.toast?.level).toBe("info");
  });

  it("term jump: singular toast for exactly one match", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({
        blocks: [makeBlock({ id: 1, role: "user", text: "only one" })],
      }),
    );
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.jumpTo("friday", "only");
    expect(chat.toast?.message).toBe("1 match");
  });

  it("term jump: empty result shows a no-matches toast and does not scroll", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ blocks: [] }));
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    // Seed existing messages so we can prove merge didn't run.
    chat.messages = [
      { id: "user_t-pre", role: "user", text: "before", status: "complete", ts: 1 },
    ];
    await chat.jumpTo("friday", "zzzznomatch");
    expect(chat.toast?.message).toBe("No matches.");
    expect(chat.scrollTarget).toBeNull();
    expect(chat.highlightedMessageId).toBeNull();
    expect(chat.messages.map((m) => m.id)).toEqual(["user_t-pre"]);
  });

  it("date jump out-of-range (no blocks on/after target): toast, no scroll", async () => {
    // around_ts past the end of chat: server returns the latest blocks
    // before the target, but nothing on or after. That's the
    // "out-of-range date" the manual test calls out.
    mockFetch.mockResolvedValueOnce(
      makeResponse({
        blocks: [
          makeBlock({ id: 1, role: "user", ts: 1_000_000 }),
          makeBlock({ id: 2, role: "assistant", ts: 1_000_100 }),
        ],
      }),
    );
    const { ChatState, parseJumpDate } = await import("./chat.svelte");
    const futureTs = parseJumpDate("2099-01-01") as number;
    expect(futureTs).toBeGreaterThan(0);
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.jumpTo("friday", "2099-01-01");
    expect(chat.toast?.message).toBe("Date is past the end of this chat.");
    expect(chat.scrollTarget).toBeNull();
  });

  it("releases pinnedToBottom so the auto-scroll effect doesn't override scrollIntoView", async () => {
    // The "scroll locks" symptom. While pinned to bottom, the
    // ResizeObserver in ChatShell pins scrollTop=scrollHeight every
    // time the message list changes height, beating the scrollIntoView
    // from the highlight effect. jumpTo must release the pin before
    // mutating messages.
    mockFetch.mockResolvedValueOnce(
      makeResponse({
        blocks: [makeBlock({ id: 1, role: "user", text: "hit", ts: 500 })],
      }),
    );
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    chat.pinnedToBottom = true;
    await chat.jumpTo("friday", "hit");
    expect(chat.pinnedToBottom).toBe(false);
  });

  it("empty arg surfaces the usage toast and never hits the network", async () => {
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.jumpTo("friday", "   ");
    expect(chat.toast?.message).toMatch(/usage:/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetch failure: warn toast, messages untouched", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("oh no", { status: 500 }),
    );
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    chat.messages = [
      { id: "b_blk-pre", role: "assistant", text: "existing", status: "complete", ts: 1, turnId: "t-pre" },
    ];
    await chat.jumpTo("friday", "anything");
    expect(chat.toast?.level).toBe("warn");
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]!.id).toBe("b_blk-pre");
  });

  it("scrollTarget nonce advances on every jump so repeats re-trigger the effect", async () => {
    // The effect that runs scrollIntoView watches `chat.scrollTarget`
    // by reference; a fresh nonce per request lets two consecutive
    // jumps to the same bubble id both fire the scroll.
    mockFetch
      .mockResolvedValueOnce(
        makeResponse({
          blocks: [makeBlock({ id: 1, blockId: "blk-x", turnId: "t-x", role: "user", text: "same", ts: 100 })],
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          blocks: [makeBlock({ id: 1, blockId: "blk-x", turnId: "t-x", role: "user", text: "same", ts: 100 })],
        }),
      );
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.jumpTo("friday", "same");
    const firstNonce = chat.scrollTarget?.nonce ?? -1;
    expect(firstNonce).toBeGreaterThan(0);
    await chat.jumpTo("friday", "same");
    expect(chat.scrollTarget?.id).toBe("user_t-x");
    expect(chat.scrollTarget?.nonce).toBeGreaterThan(firstNonce);
  });
});

describe("parseJumpDate", () => {
  it("today returns midnight, not noon — earliest block first", async () => {
    const { parseJumpDate } = await import("./chat.svelte");
    const ts = parseJumpDate("today");
    expect(ts).not.toBeNull();
    const d = new Date(ts as number);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
  });

  it("yesterday returns midnight of yesterday", async () => {
    const { parseJumpDate } = await import("./chat.svelte");
    const ts = parseJumpDate("yesterday") as number;
    const todayMidnight = (() => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    })();
    // 86_400_000 ms in a day. DST transitions can shift this by an
    // hour, so compare within a small window.
    const delta = todayMidnight - ts;
    expect(delta).toBeGreaterThan(82_000_000);
    expect(delta).toBeLessThan(90_000_000);
  });

  it("ISO date returns midnight of that day", async () => {
    const { parseJumpDate } = await import("./chat.svelte");
    const ts = parseJumpDate("2026-05-10");
    expect(ts).not.toBeNull();
    // Date.parse on a bare ISO date returns midnight UTC.
    expect(ts).toBe(Date.UTC(2026, 4, 10));
  });

  it("nonsense term returns null so the caller falls back to FTS", async () => {
    const { parseJumpDate } = await import("./chat.svelte");
    expect(parseJumpDate("not a date at all banana")).toBeNull();
  });
});

describe("mail block rendering", () => {
  // Mail-bridge materializes incoming mail as a role='user' block with
  // source='mail' and from_agent inside content_json (see
  // daemon/src/comms/mail-bridge.ts and daemon/src/agent/lifecycle.ts).
  // The dashboard must surface source + fromAgent so the renderer can
  // style mail as an incoming agent message rather than a user bubble.
  it("live SSE: block_complete with source=mail surfaces source + fromAgent on the ChatMessage", async () => {
    const { ChatState, userBlockIdForTurn } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    chat.applyEvent({
      v: 1,
      type: "block_complete",
      turn_id: "mail_42",
      agent: "friday",
      block_id: "blk-mail-1",
      message_id: null,
      block_index: 0,
      kind: "text",
      role: "user",
      source: "mail",
      content_json:
        '{"text":"Page title: Example Domain","from_agent":"builtin-browser-1"}',
      status: "complete",
      ts: 1000,
      seq: 5,
    } as Parameters<typeof chat.applyEvent>[0]);
    expect(chat.messages.length).toBe(1);
    const m = chat.messages[0]!;
    expect(m.id).toBe(userBlockIdForTurn("mail_42"));
    expect(m.role).toBe("user");
    expect(m.source).toBe("mail");
    expect(m.fromAgent).toBe("builtin-browser-1");
    expect(m.text).toBe("Page title: Example Domain");
  });

  it("reload path: parseBlocks surfaces fromAgent from content_json", async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        makeResponse({
          blocks: [
            {
              id: 1,
              blockId: "blk-mail-reload",
              turnId: "mail_99",
              agentName: "friday",
              sessionId: "s",
              messageId: null,
              blockIndex: 0,
              role: "user",
              kind: "text",
              source: "mail",
              contentJson:
                '{"text":"reload body","from_agent":"scope-sanity-2"}',
              status: "complete",
              ts: 100,
              lastEventSeq: 1,
            },
          ],
          lastEventSeq: 1,
        }),
      )
      .mockResolvedValueOnce(makeResponse({ status: "idle" }));
    const { ChatState, userBlockIdForTurn } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.loadAgentTurns("friday");
    const mail = chat.messages.find(
      (x) => x.id === userBlockIdForTurn("mail_99"),
    );
    expect(mail, "mail block must be present after reload").toBeDefined();
    expect(mail?.source).toBe("mail");
    expect(mail?.fromAgent).toBe("scope-sanity-2");
    expect(mail?.text).toBe("reload body");
  });

  it("reload path: parseBlocks surfaces attachments from content_json (FRI-6)", async () => {
    // The daemon persists user-chat attachments under
    // `content_json.attachments`. Reload reads the row back via
    // /api/agents/:name/blocks; the user-bubble must regain its chip
    // row or the image vanishes from the chat after a page refresh.
    const atts = [
      { sha256: "a".repeat(64), filename: "shot.png", mime: "image/png" },
    ];
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        makeResponse({
          blocks: [
            {
              id: 1,
              blockId: "blk-att-reload",
              turnId: "turn_paste_1",
              agentName: "friday",
              sessionId: "s",
              messageId: null,
              blockIndex: 0,
              role: "user",
              kind: "text",
              source: "user_chat",
              contentJson: JSON.stringify({
                text: "look at this",
                attachments: atts,
              }),
              status: "complete",
              ts: 100,
              lastEventSeq: 1,
            },
          ],
          lastEventSeq: 1,
        }),
      )
      .mockResolvedValueOnce(makeResponse({ status: "idle" }));
    const { ChatState, userBlockIdForTurn } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    await chat.loadAgentTurns("friday");
    const m = chat.messages.find(
      (x) => x.id === userBlockIdForTurn("turn_paste_1"),
    );
    expect(m, "user block must be present after reload").toBeDefined();
    expect(m?.text).toBe("look at this");
    expect(m?.attachments).toEqual(atts);
  });

  it("live SSE: mail metadata (id/subject/type/priority/threadId/ts) is extracted from content_json", async () => {
    const { ChatState, userBlockIdForTurn } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    chat.applyEvent({
      v: 1,
      type: "block_complete",
      turn_id: "mail_77",
      agent: "friday",
      block_id: "blk-mail-meta",
      message_id: null,
      block_index: 0,
      kind: "text",
      role: "user",
      source: "mail",
      content_json: JSON.stringify({
        text: "rich body",
        from_agent: "builder-7",
        mail_id: 77,
        mail_subject: "kickoff",
        mail_type: "message",
        mail_priority: "critical",
        mail_thread_id: "th-abc",
        mail_ts: 1700000000000,
      }),
      status: "complete",
      ts: 1700000000050,
      seq: 9,
    } as Parameters<typeof chat.applyEvent>[0]);
    const m = chat.messages.find(
      (x) => x.id === userBlockIdForTurn("mail_77"),
    );
    expect(m, "mail block must be present").toBeDefined();
    expect(m?.mailMeta).toEqual({
      id: 77,
      subject: "kickoff",
      type: "message",
      priority: "critical",
      threadId: "th-abc",
      ts: 1700000000000,
    });
  });

  it("legacy mail block (no mail_id in content_json) leaves mailMeta undefined", async () => {
    const { ChatState, userBlockIdForTurn } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    chat.applyEvent({
      v: 1,
      type: "block_complete",
      turn_id: "mail_old",
      agent: "friday",
      block_id: "blk-legacy",
      message_id: null,
      block_index: 0,
      kind: "text",
      role: "user",
      source: "mail",
      content_json: '{"text":"legacy body","from_agent":"old-agent"}',
      status: "complete",
      ts: 1000,
      seq: 1,
    } as Parameters<typeof chat.applyEvent>[0]);
    const m = chat.messages.find(
      (x) => x.id === userBlockIdForTurn("mail_old"),
    );
    expect(m?.source).toBe("mail");
    expect(m?.fromAgent).toBe("old-agent");
    expect(m?.mailMeta).toBeUndefined();
  });

  it("regression guard: source=user_chat blocks do NOT pick up fromAgent", async () => {
    const { ChatState, userBlockIdForTurn } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    chat.applyEvent({
      v: 1,
      type: "block_complete",
      turn_id: "turn-uc-1",
      agent: "friday",
      block_id: "blk-uc",
      message_id: null,
      block_index: 0,
      kind: "text",
      role: "user",
      source: "user_chat",
      content_json: '{"text":"typed by seth"}',
      status: "complete",
      ts: 200,
      seq: 1,
    } as Parameters<typeof chat.applyEvent>[0]);
    const uc = chat.messages.find(
      (x) => x.id === userBlockIdForTurn("turn-uc-1"),
    );
    expect(uc, "user_chat block should be present").toBeDefined();
    expect(uc?.source).toBe("user_chat");
    expect(uc?.fromAgent).toBeUndefined();
    expect(uc?.text).toBe("typed by seth");
  });
});

// PR B — sidebar realtime / UNKNOWN type / Show-archived.
describe("agent_lifecycle handling (PR B)", () => {
  it("F2-B: agent_status for an unknown agent does NOT insert a row", async () => {
    // The bug we're guarding: an agent_status SSE event arrived for an
    // agent the dashboard hadn't yet seen (still mid-spawn, or replayed
    // after /api/agents fetched). upsertAgent used to default
    // type="unknown" and render a literal UNKNOWN-typed row. Now it
    // refuses the insert until a lifecycle event with `type` lands.
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.agents = [];
    chat.applyEvent({
      v: 1,
      type: "agent_status",
      agent: "ghost-agent",
      status: "working",
      since: 1,
      seq: 1,
    } as Parameters<typeof chat.applyEvent>[0]);
    expect(chat.agents.find((a) => a.name === "ghost-agent")).toBeUndefined();
  });

  it("F2-B: agent_status for a known agent updates status without changing type", async () => {
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.agents = [
      {
        name: "alpha",
        type: "builder",
        status: "working",
      },
    ];
    chat.applyEvent({
      v: 1,
      type: "agent_status",
      agent: "alpha",
      status: "stalled",
      since: 2,
      seq: 2,
    } as Parameters<typeof chat.applyEvent>[0]);
    const a = chat.agents.find((x) => x.name === "alpha");
    expect(a?.type).toBe("builder");
    expect(a?.status).toBe("stalled");
  });

  it("F2-C: agent_lifecycle: archive marks status=archived (does NOT remove the row)", async () => {
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.agents = [
      {
        name: "beta",
        type: "builder",
        status: "working",
      },
    ];
    chat.applyEvent({
      v: 1,
      type: "agent_lifecycle",
      agent: "beta",
      agentType: "builder",
      event: "archive",
      seq: 3,
    } as Parameters<typeof chat.applyEvent>[0]);
    const b = chat.agents.find((x) => x.name === "beta");
    expect(b, "row stays in agents list").toBeDefined();
    expect(b?.status).toBe("archived");
  });

  it("F2-A: agent_lifecycle: complete flips a known agent to idle", async () => {
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.agents = [
      {
        name: "gamma",
        type: "helper",
        status: "working",
      },
    ];
    chat.applyEvent({
      v: 1,
      type: "agent_lifecycle",
      agent: "gamma",
      agentType: "helper",
      event: "complete",
      seq: 4,
    } as Parameters<typeof chat.applyEvent>[0]);
    expect(chat.agents.find((x) => x.name === "gamma")?.status).toBe("idle");
  });

  it("F2-A: agent_lifecycle: complete for an unknown agent is a no-op", async () => {
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.agents = [];
    chat.applyEvent({
      v: 1,
      type: "agent_lifecycle",
      agent: "ghost",
      agentType: "helper",
      event: "complete",
      seq: 5,
    } as Parameters<typeof chat.applyEvent>[0]);
    expect(chat.agents).toHaveLength(0);
  });
});

// PR C — phantom orchestrator badges.
describe("unread badge gating (PR C)", () => {
  it("F3-A guard verified at the consumer: agent_message increments only for that agent's badge", async () => {
    // The dashboard's side of F3-A: assistant `agent_message` bumps a
    // non-focused agent's badge. The daemon-side change (only emitting
    // for role=assistant) is enforced by maybeEmitAgentMessage and
    // covered separately. Here we verify the dashboard still bumps when
    // an event arrives.
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    chat.applyEvent({
      v: 1,
      type: "agent_message",
      agent: "alpha",
      turn_id: "t-1",
      block_id: "b-1",
      kind: "block_complete",
      preview: "hi",
      seq: 1,
    } as Parameters<typeof chat.applyEvent>[0]);
    expect(chat.unreadByAgent["alpha"]).toBe(1);
  });

  it("F3-A: focused agent's own agent_message does NOT bump (existing behavior)", async () => {
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    chat.applyEvent({
      v: 1,
      type: "agent_message",
      agent: "friday",
      turn_id: "t-1",
      block_id: "b-1",
      kind: "block_complete",
      preview: "hi",
      seq: 1,
    } as Parameters<typeof chat.applyEvent>[0]);
    expect(chat.unreadByAgent["friday"]).toBeUndefined();
  });

  it("F3-B: mail_delivered events do NOT bump the unread badge", async () => {
    // The phantom orchestrator badge problem: every inter-agent mail
    // triggered a mail_delivered bump AND a later agent_message bump
    // for the recipient's user-role mail block. Net: 2+ badges per
    // logical mail event. F3-B drops the mail_delivered bump; the
    // assistant reply that follows is the load-bearing signal.
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    chat.applyEvent({
      v: 1,
      type: "mail_delivered",
      agent: "builder-1",
      to: "friday-2",
      priority: "normal",
      seq: 1,
    } as unknown as Parameters<typeof chat.applyEvent>[0]);
    expect(chat.unreadByAgent["friday-2"]).toBeUndefined();
  });

  it("F3-C: lastSeqByAgent advances on accepted events (cursor mechanism)", async () => {
    // The cursor mechanism is what F3-C persists. This test pins the
    // in-memory advance; the localStorage persistence is exercised
    // through the mocked saveJSON helper.
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    chat.applyEvent({
      v: 1,
      type: "agent_message",
      agent: "beta",
      turn_id: "t-1",
      block_id: "b-1",
      kind: "block_complete",
      preview: "x",
      seq: 7,
    } as Parameters<typeof chat.applyEvent>[0]);
    expect(chat.lastSeqByAgent["beta"]).toBe(7);
    // saveJSON should have been called with the updated map.
    expect(mockSaveJSON).toHaveBeenCalledWith(
      "chat:lastSeqByAgent",
      expect.objectContaining({ beta: 7 }),
    );
  });

  it("PR D: stale agent_status for an archived agent does NOT flip status back", async () => {
    // Scenario: dashboard cold-load, /api/agents returns the agent as
    // archived, then SSE ring-buffer replays an old agent_status:working
    // from before the archive. Without this guard the row would flip to
    // working and the sidebar would render a green pulsing dot on a
    // corpse.
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.agents = [
      { name: "ghost-builder", type: "builder", status: "archived" },
    ];
    chat.applyEvent({
      v: 1,
      type: "agent_status",
      agent: "ghost-builder",
      status: "working",
      since: 1,
      seq: 1,
    } as Parameters<typeof chat.applyEvent>[0]);
    expect(
      chat.agents.find((a) => a.name === "ghost-builder")?.status,
    ).toBe("archived");
  });

  it("PR D: stale agent_lifecycle:complete for an archived agent does NOT flip to idle", async () => {
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.agents = [
      { name: "ghost-builder", type: "builder", status: "archived" },
    ];
    chat.applyEvent({
      v: 1,
      type: "agent_lifecycle",
      agent: "ghost-builder",
      agentType: "builder",
      event: "complete",
      seq: 2,
    } as Parameters<typeof chat.applyEvent>[0]);
    expect(
      chat.agents.find((a) => a.name === "ghost-builder")?.status,
    ).toBe("archived");
  });

  it("PR D: stale turn_started for an archived focused agent does NOT set inflightTurnId", async () => {
    // The "Stop" button on an archived agent's history view came from
    // here: the ring-buffer replay set inflightTurnId on the focused
    // archived agent, but no matching turn_done followed (either evicted
    // from the buffer or the buffer truncated). Guard at the entry.
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "ghost-builder";
    chat.agents = [
      { name: "ghost-builder", type: "builder", status: "archived" },
    ];
    chat.applyEvent({
      v: 1,
      type: "turn_started",
      agent: "ghost-builder",
      turn_id: "t-stale",
      ts: 1,
      seq: 1,
    } as Parameters<typeof chat.applyEvent>[0]);
    expect(chat.inflightTurnId).toBeNull();
  });

  it("F3-C: stale seqs are dropped (dedup against persisted cursor)", async () => {
    // If the persisted cursor for an agent is N, a replayed event with
    // seq <= N must be dropped — no badge bump, no state churn.
    mockLoadJSON.mockImplementation((key: string) => {
      if (key === "chat:lastSeqByAgent") return { gamma: 5 };
      return [];
    });
    const { ChatState } = await import("./chat.svelte");
    const chat = new ChatState();
    chat.focusedAgent = "friday";
    chat.applyEvent({
      v: 1,
      type: "agent_message",
      agent: "gamma",
      turn_id: "t-1",
      block_id: "b-1",
      kind: "block_complete",
      preview: "stale",
      seq: 3, // <= persisted cursor 5
    } as Parameters<typeof chat.applyEvent>[0]);
    expect(chat.unreadByAgent["gamma"]).toBeUndefined();
  });
});
