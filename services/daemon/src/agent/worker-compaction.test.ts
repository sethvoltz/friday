/**
 * FRI-60: worker compact_boundary detection.
 *
 * Verifies that when the SDK iterator yields a `compact_boundary` system
 * frame, the `turn-complete` IPC carries `compactionThisTurn: true`, and
 * that a normal turn (no compact_boundary) produces falsy `compactionThisTurn`.
 *
 * Strategy: mock `@anthropic-ai/claude-agent-sdk`'s `query` export, then
 * isolate-import the worker module to get fresh global state, trigger it via
 * `process.emit("message", ...)`, and inspect `process.send` captures.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Prevent the worker's `process.exit(0)` (one-shot mainLoop finally) from
// killing the vitest process. Spy-and-noop just for exit, leave everything
// else on the real process object.
vi.spyOn(process, "exit").mockImplementation((_code?: number | string) => {
  return undefined as never;
});

// ---- module-level mocks wired before worker is first imported ----

const mockQueryImpl = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQueryImpl(...args),
}));

vi.mock("../mcp/builder.js", () => ({
  buildMcpServers: vi.fn(() => []),
}));

vi.mock("../comms/mail-prompt.js", () => ({
  buildMailPrompt: vi.fn(() => ""),
}));

vi.mock("../mcp/http.js", () => ({
  daemonFetch: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ mails: [] }),
  }),
}));

vi.mock("@friday/shared/services", () => ({
  readAttachmentBytes: vi.fn().mockResolvedValue(null),
}));

vi.mock("../hooks/register.js", () => ({}));

vi.mock("@friday/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@friday/shared")>();
  return {
    ...actual,
    renderLocalDatetime: vi.fn(() => ""),
    runHooks: vi.fn().mockResolvedValue([]),
  };
});

// ---- helpers ----

const RESULT_MSG = {
  type: "result",
  stop_reason: "end_turn",
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  total_cost_usd: 0,
};

const COMPACT_BOUNDARY_MSG = {
  type: "system",
  subtype: "compact_boundary",
  compact_metadata: { pre_tokens: 80000, post_tokens: 40000, duration_ms: 1200 },
};

async function* makeIterator(
  msgs: Record<string, unknown>[],
): AsyncGenerator<Record<string, unknown>> {
  for (const m of msgs) yield m;
}

function makeStartCmd() {
  return {
    type: "start",
    options: {
      agentName: "test-agent",
      agentType: "orchestrator",
      mode: "one-shot",
      workingDirectory: "/tmp/test-worker",
      systemPrompt: "",
      prompt: "hello",
      turnId: "t_worker_test",
      model: "claude-opus-4-7",
      daemonPort: 9999,
    },
  };
}

// Drain all IPC from a single one-shot worker run.
async function runWorker(
  sdkMsgs: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  mockQueryImpl.mockImplementation(() => makeIterator(sdkMsgs));

  // Intercept process.send before importing so the ready-emit is captured.
  const sent: Record<string, unknown>[] = [];
  const origSend = process.send;
  process.send = ((msg: Record<string, unknown>) => {
    sent.push(msg);
    return true;
  }) as typeof process.send;

  // Fresh module state for each test.
  vi.resetModules();
  await import("./worker.js");

  // Trigger mainLoop via "start" IPC.
  process.emit("message", makeStartCmd() as never, undefined as never);

  // Wait for turn-complete or error (one-shot exits after one turn).
  // Poll with a hard ceiling to avoid hanging.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (sent.some((m) => m.type === "turn-complete" || m.type === "error")) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  process.send = origSend;
  return sent;
}

// ---- tests ----

describe("worker: compact_boundary detection (FRI-60)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockQueryImpl.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("sets compactionThisTurn: true when compact_boundary precedes result", async () => {
    const sent = await runWorker([COMPACT_BOUNDARY_MSG, RESULT_MSG]);

    const tc = sent.find((m) => m.type === "turn-complete");
    expect(tc).toBeDefined();
    expect(tc?.compactionThisTurn).toBe(true);
  });

  it("compactionThisTurn is falsy when no compact_boundary is seen", async () => {
    const sent = await runWorker([RESULT_MSG]);

    const tc = sent.find((m) => m.type === "turn-complete");
    expect(tc).toBeDefined();
    // compactionThisTurn should be omitted (undefined) on a normal turn
    expect(tc?.compactionThisTurn).toBeFalsy();
  });
});
