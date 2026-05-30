/**
 * Regression: a queued message that arrives while the agent is mid-turn must
 * not orphan the in-flight reply.
 *
 * Root cause (reproduced live, 2026-05-30): with extended thinking, the SDK
 * surfaces an `assistant`-message boundary for the THINKING block BEFORE the
 * reply text streams (`m.message.content === ['thinking']`), then a second
 * boundary once the text arrives. The prompts-pending / critical-mail break
 * fired at the thinking-only boundary, `flushBoundaryBlocks` CANCELLED the
 * empty thinking block, and the turn emitted `turn-complete` with ZERO
 * captured blocks. The model's real reply then streamed out-of-band into the
 * session JSONL after the worker had moved to the queued turn, and post-turn
 * recovery orphaned it under `recover_<session>` with a late timestamp — the
 * dashboard's "Agent didn't respond" + reordered-conversation bug.
 *
 * Fix: gate the break on reply-content-present (`assistantMessageHasText`).
 * A thinking-only boundary `continue`s so the reply streams and is captured
 * under THIS turn; the break fires only at the text boundary. tool_use turns
 * still defer via `breakAtNextUser` (FRI-78), unchanged.
 *
 * The cross-boundary tests below drive a scripted SDK stream (mirroring
 * worker-result-heal.test.ts). They are load-bearing: without the guard the
 * worker breaks at the thinking-only boundary and never consumes the text
 * frames, so the "reply captured" assertion fails.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.spyOn(process, "exit").mockImplementation((_code?: number | string) => {
  return undefined as never;
});

const mockQueryImpl = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQueryImpl(...args),
}));
vi.mock("../mcp/builder.js", () => ({ buildMcpServers: vi.fn(() => []) }));
vi.mock("../comms/mail-prompt.js", () => ({ buildMailPrompt: vi.fn(() => "") }));
vi.mock("../mcp/http.js", () => ({
  daemonFetch: vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, json: async () => ({ mails: [] }) }),
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

const SESSION = "sess-thinking-break";
const REPLY = "Bob pays $12, Alice $24, Carol $18.";
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── pure-function discriminator ──────────────────────────────────────────
describe("assistantMessageHasText", () => {
  it("is false for a thinking-only message (the bug boundary)", async () => {
    const { assistantMessageHasText } = await import("./worker.js");
    expect(assistantMessageHasText({ content: [{ type: "thinking", thinking: "" }] })).toBe(false);
  });
  it("is true once a text block is present", async () => {
    const { assistantMessageHasText } = await import("./worker.js");
    expect(
      assistantMessageHasText({ content: [{ type: "thinking" }, { type: "text", text: "hi" }] }),
    ).toBe(true);
  });
  it("is false for a tool_use-only message (deferral is handled separately)", async () => {
    const { assistantMessageHasText } = await import("./worker.js");
    expect(
      assistantMessageHasText({ content: [{ type: "tool_use", id: "t", name: "Bash" }] }),
    ).toBe(false);
  });
  it("is false for non-array / missing content", async () => {
    const { assistantMessageHasText } = await import("./worker.js");
    expect(assistantMessageHasText({})).toBe(false);
    expect(assistantMessageHasText(null)).toBe(false);
  });
});

// ── cross-boundary: drive a scripted SDK stream through runQuery ──────────
describe("mid-turn break does not orphan the reply (thinking-first)", () => {
  let fakeHome: string;
  let workDir: string;

  beforeEach(() => {
    vi.resetModules();
    mockQueryImpl.mockReset();
    fakeHome = mkdtempSync(join(tmpdir(), "friday-think-break-h-"));
    workDir = mkdtempSync(join(tmpdir(), "friday-think-break-cwd-"));
    vi.stubEnv("HOME", fakeHome);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    try {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  /** Drive the worker with a scripted iterator + a prompts-pending IPC armed
   *  as soon as the session is announced. Returns the IPC messages sent. */
  async function run(
    iter: () => AsyncGenerator<Record<string, unknown>>,
  ): Promise<Record<string, unknown>[]> {
    mockQueryImpl.mockImplementation(() => iter());
    const sent: Record<string, unknown>[] = [];
    const origSend = process.send;
    process.send = ((msg: Record<string, unknown>) => {
      sent.push(msg);
      // Arm the mid-turn break before the assistant boundaries land.
      if (msg.type === "session-update") {
        process.emit("message", { type: "prompts-pending" } as never, undefined as never);
      }
      return true;
    }) as typeof process.send;
    await import("./worker.js");
    process.emit(
      "message",
      {
        type: "start",
        options: {
          agentName: "think-agent",
          agentType: "orchestrator",
          mode: "one-shot",
          workingDirectory: workDir,
          systemPrompt: "",
          prompt: "solve it",
          turnId: "t_think",
          model: "claude-opus-4-7",
          daemonPort: 9999,
        },
      } as never,
      undefined as never,
    );
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (sent.some((m) => m.type === "turn-complete" || m.type === "error")) break;
      await tick(20);
    }
    process.send = origSend;
    return sent;
  }

  it("captures the reply under THIS turn when the break is armed during thinking", async () => {
    // Thinking-only boundary FIRST (prompts-pending already armed), then the
    // reply text streams on a later boundary.
    async function* thinkingThenText(): AsyncGenerator<Record<string, unknown>> {
      yield { type: "system", subtype: "init", session_id: SESSION };
      yield {
        type: "stream_event",
        session_id: SESSION,
        event: { type: "message_start", message: { id: "msg_1" } },
      };
      yield {
        type: "stream_event",
        session_id: SESSION,
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      };
      // thinking-only assistant boundary — the bug fired the break HERE.
      yield {
        type: "assistant",
        session_id: SESSION,
        message: { id: "msg_1", content: [{ type: "thinking", thinking: "" }] },
      };
      await tick();
      yield {
        type: "stream_event",
        session_id: SESSION,
        event: { type: "content_block_stop", index: 0 },
      };
      yield {
        type: "stream_event",
        session_id: SESSION,
        event: { type: "content_block_start", index: 1, content_block: { type: "text" } },
      };
      yield {
        type: "stream_event",
        session_id: SESSION,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: REPLY },
        },
      };
      // reply boundary — the break should fire HERE, after the reply streamed.
      yield {
        type: "assistant",
        session_id: SESSION,
        message: { id: "msg_1", content: [{ type: "text", text: REPLY }] },
      };
      yield {
        type: "result",
        session_id: SESSION,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        total_cost_usd: 0,
      };
    }

    const sent = await run(thinkingThenText);

    const stops = sent.filter((m) => m.type === "block-stop");
    const replyStop = stops.find(
      (m) => typeof m.contentJson === "string" && (m.contentJson as string).includes(REPLY),
    );
    // The reply was captured (block-stop, not block-cancel) under this turn.
    expect(replyStop, "reply must be captured via block-stop").toBeTruthy();
    expect(replyStop?.status).toBe("complete");
    // It must NOT have been cancelled.
    const cancels = sent.filter((m) => m.type === "block-cancel");
    expect(cancels.length, "no block should be cancelled").toBe(0);
    // The turn completed (not errored).
    expect(sent.some((m) => m.type === "turn-complete")).toBe(true);
    expect(sent.some((m) => m.type === "error")).toBe(false);
    // Ordering: the reply was captured BEFORE turn-complete.
    const replyIdx = sent.indexOf(replyStop!);
    const tcIdx = sent.findIndex((m) => m.type === "turn-complete");
    expect(replyIdx).toBeLessThan(tcIdx);
  });

  it("breaks at the first reply boundary for a pure-text turn (no over-deferral)", async () => {
    // No thinking block: the very first assistant boundary carries the reply,
    // so the break must fire immediately and NOT consume a later step.
    async function* pureText(): AsyncGenerator<Record<string, unknown>> {
      yield { type: "system", subtype: "init", session_id: SESSION };
      yield {
        type: "stream_event",
        session_id: SESSION,
        event: { type: "message_start", message: { id: "msg_2" } },
      };
      yield {
        type: "stream_event",
        session_id: SESSION,
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      };
      yield {
        type: "stream_event",
        session_id: SESSION,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: REPLY },
        },
      };
      yield {
        type: "assistant",
        session_id: SESSION,
        message: { id: "msg_2", content: [{ type: "text", text: REPLY }] },
      };
      // If the break (wrongly) over-deferred, the worker would consume this:
      yield {
        type: "stream_event",
        session_id: SESSION,
        event: { type: "content_block_start", index: 1, content_block: { type: "text" } },
      };
      yield {
        type: "stream_event",
        session_id: SESSION,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "SHOULD_NOT_APPEAR" },
        },
      };
      yield {
        type: "assistant",
        session_id: SESSION,
        message: { id: "msg_2", content: [{ type: "text", text: "SHOULD_NOT_APPEAR" }] },
      };
      yield {
        type: "result",
        session_id: SESSION,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        total_cost_usd: 0,
      };
    }

    const sent = await run(pureText);

    expect(
      sent.some(
        (m) =>
          m.type === "block-stop" &&
          typeof m.contentJson === "string" &&
          (m.contentJson as string).includes(REPLY),
      ),
    ).toBe(true);
    // Proof the break fired at the first reply boundary: the second step was
    // never consumed.
    expect(sent.some((m) => JSON.stringify(m).includes("SHOULD_NOT_APPEAR"))).toBe(false);
    expect(sent.some((m) => m.type === "turn-complete")).toBe(true);
  });
});
