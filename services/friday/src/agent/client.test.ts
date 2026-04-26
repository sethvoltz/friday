import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies before importing client
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../sessions/manager.js", () => ({
  getSessionId: vi.fn(() => null),
  setSessionId: vi.fn(),
}));

vi.mock("../monitor/usage.js", () => ({
  logUsage: vi.fn(),
}));

vi.mock("../log.js", () => ({
  log: vi.fn(),
}));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { sendToAgent } = await import("./client.js");

const mockQuery = query as ReturnType<typeof vi.fn>;

const baseOptions = {
  channelId: "C123",
  isOrchestrator: true,
  workingDirectory: "/tmp/test",
  allowedTools: ["Read"],
  model: "claude-sonnet-4-6",
};

/** Helper: create an async iterable from an array of messages */
async function* fakeStream(messages: any[]) {
  for (const msg of messages) {
    yield msg;
  }
}

const resultMessage = {
  type: "result",
  subtype: "success",
  session_id: "sess-123",
  usage: { input_tokens: 100, output_tokens: 50 },
  total_cost_usd: 0.01,
};

function assistantMessage(text: string) {
  return {
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
    },
  };
}

describe("sendToAgent thinking indicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockQuery.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start timer when no onThinkingStart callback", async () => {
    mockQuery.mockReturnValue(
      fakeStream([assistantMessage("hello"), resultMessage])
    );

    const onChunk = vi.fn();
    const promise = sendToAgent("test", baseOptions, { onChunk });

    // Advance past any threshold — no thinking callbacks should fire
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    expect(onChunk).toHaveBeenCalledWith("hello");
  });

  it("fires onThinkingStart after delay when no content arrives", async () => {
    // Stream that yields content only after we advance timers
    let resolve: () => void;
    const gate = new Promise<void>((r) => { resolve = r; });

    async function* delayedStream() {
      await gate;
      yield assistantMessage("done");
      yield resultMessage;
    }

    mockQuery.mockReturnValue(delayedStream());

    const onThinkingStart = vi.fn();
    const onThinkingTick = vi.fn();
    const onThinkingEnd = vi.fn();

    const promise = sendToAgent("test", {
      ...baseOptions,
      thinkingIndicatorDelaySec: 5,
    }, {
      onThinkingStart,
      onThinkingTick,
      onThinkingEnd,
    });

    // Before threshold — nothing fires
    await vi.advanceTimersByTimeAsync(4_000);
    expect(onThinkingStart).not.toHaveBeenCalled();

    // At threshold — onThinkingStart fires
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onThinkingStart).toHaveBeenCalledTimes(1);
    expect(onThinkingStart.mock.calls[0][0]).toBe(5);

    // Next interval — onThinkingTick fires
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onThinkingTick).toHaveBeenCalledTimes(1);
    expect(onThinkingTick.mock.calls[0][0]).toBe(10);

    // Release the stream — content arrives, onThinkingEnd fires
    resolve!();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(onThinkingEnd).toHaveBeenCalledTimes(1);
  });

  it("clears timer on first text content without calling onThinkingEnd if not started", async () => {
    // Content arrives before the threshold
    mockQuery.mockReturnValue(
      fakeStream([assistantMessage("fast response"), resultMessage])
    );

    const onThinkingStart = vi.fn();
    const onThinkingEnd = vi.fn();

    await sendToAgent("test", {
      ...baseOptions,
      thinkingIndicatorDelaySec: 30,
    }, {
      onThinkingStart,
      onThinkingEnd,
    });

    // Content arrived immediately — timer never fired
    expect(onThinkingStart).not.toHaveBeenCalled();
    expect(onThinkingEnd).not.toHaveBeenCalled();
  });

  it("pauses timer during compaction", async () => {
    let resolve: () => void;
    const gate = new Promise<void>((r) => { resolve = r; });

    async function* compactingStream() {
      // Compaction starts before thinking threshold
      yield { type: "system", subtype: "status", status: "compacting" };
      await gate;
      yield { type: "system", subtype: "status", compact_result: "success" };
      yield assistantMessage("done");
      yield resultMessage;
    }

    mockQuery.mockReturnValue(compactingStream());

    const onThinkingStart = vi.fn();
    const onCompactStart = vi.fn();

    const promise = sendToAgent("test", {
      ...baseOptions,
      thinkingIndicatorDelaySec: 5,
    }, {
      onThinkingStart,
      onCompactStart,
    });

    // Let compaction message be processed
    await vi.advanceTimersByTimeAsync(0);

    // Advance well past threshold — thinking should NOT fire (paused during compaction)
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onThinkingStart).not.toHaveBeenCalled();
    expect(onCompactStart).toHaveBeenCalledTimes(1);

    // Release — compaction ends, content arrives
    resolve!();
    await vi.advanceTimersByTimeAsync(0);
    await promise;
  });

  it("clears timer in finally block on error", async () => {
    async function* errorStream() {
      yield {
        type: "result",
        subtype: "error",
        session_id: "sess-err",
      };
    }

    mockQuery.mockReturnValue(errorStream());

    const onThinkingStart = vi.fn();
    const onThinkingEnd = vi.fn();

    await expect(
      sendToAgent("test", {
        ...baseOptions,
        thinkingIndicatorDelaySec: 5,
      }, {
        onThinkingStart,
        onThinkingEnd,
      })
    ).rejects.toThrow("Agent ended with status: error");

    // Timer should be cleaned up — advance and verify no late callbacks
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onThinkingStart).not.toHaveBeenCalled();
  });

  it("fires onToolUse with tool name when tool_progress event arrives", async () => {
    const toolProgressMessage = {
      type: "tool_progress",
      tool_use_id: "tu-1",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 0.5,
      uuid: "uuid-1",
      session_id: "sess-123",
    };

    mockQuery.mockReturnValue(
      fakeStream([toolProgressMessage, assistantMessage("done"), resultMessage])
    );

    const onToolUse = vi.fn();
    await sendToAgent("test", baseOptions, { onToolUse });

    expect(onToolUse).toHaveBeenCalledTimes(1);
    expect(onToolUse).toHaveBeenCalledWith("Bash");
  });

  it("fires onToolUse multiple times for multiple tool events", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "tool_progress", tool_use_id: "tu-1", tool_name: "Read", parent_tool_use_id: null, elapsed_time_seconds: 0.1, uuid: "u1", session_id: "sess-123" },
        { type: "tool_progress", tool_use_id: "tu-2", tool_name: "WebFetch", parent_tool_use_id: null, elapsed_time_seconds: 0.2, uuid: "u2", session_id: "sess-123" },
        { type: "tool_progress", tool_use_id: "tu-3", tool_name: "Agent", parent_tool_use_id: null, elapsed_time_seconds: 0.3, uuid: "u3", session_id: "sess-123" },
        assistantMessage("result"),
        resultMessage,
      ])
    );

    const onToolUse = vi.fn();
    await sendToAgent("test", baseOptions, { onToolUse });

    expect(onToolUse).toHaveBeenCalledTimes(3);
    expect(onToolUse.mock.calls.map((c) => c[0])).toEqual(["Read", "WebFetch", "Agent"]);
  });

  it("does not call onToolUse when callback is not provided", async () => {
    const toolProgressMessage = {
      type: "tool_progress",
      tool_use_id: "tu-1",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 0.5,
      uuid: "uuid-1",
      session_id: "sess-123",
    };

    mockQuery.mockReturnValue(
      fakeStream([toolProgressMessage, assistantMessage("done"), resultMessage])
    );

    // Should not throw even without callback
    await expect(sendToAgent("test", baseOptions, {})).resolves.toBe("done");
  });

  it("defaults to 30s when thinkingIndicatorDelaySec not set", async () => {
    let resolve: () => void;
    const gate = new Promise<void>((r) => { resolve = r; });

    async function* delayedStream() {
      await gate;
      yield assistantMessage("done");
      yield resultMessage;
    }

    mockQuery.mockReturnValue(delayedStream());

    const onThinkingStart = vi.fn();
    const promise = sendToAgent("test", baseOptions, { onThinkingStart });

    // At 29s — not yet
    await vi.advanceTimersByTimeAsync(29_000);
    expect(onThinkingStart).not.toHaveBeenCalled();

    // At 30s — fires
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onThinkingStart).toHaveBeenCalledTimes(1);

    resolve!();
    await vi.advanceTimersByTimeAsync(0);
    await promise;
  });
});
