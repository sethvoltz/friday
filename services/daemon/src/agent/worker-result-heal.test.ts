/**
 * FRI-127 §7 / AC#10: when the SDK delivers `result` while a pending-injection
 * break is deferred for an outstanding `tool_use` (breakAtNextUser=true, no
 * intervening synthetic `user(tool_result)`), the worker's result
 * short-circuit must (a) heal the SDK session JSONL by appending a synthetic
 * tool_result for the dangling tool_use, and (b) still emit `turn-complete`
 * (not hang).
 *
 * Strategy mirrors `worker-compaction.test.ts`: mock the SDK `query` export,
 * isolate-import the worker, drive it via `process.emit("message", ...)`,
 * inject a `prompts-pending` IPC before the `result` lands so breakAtNextUser
 * is armed, and pre-write a dangling JSONL at the SDK session path so the heal
 * has a transcript to repair.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

const SESSION = "sess-break-heal";
const TOOL_USE_ID = "tu_dangling";
let fakeHome: string;
let workDir: string;

// Build the path the heal will target (mirrors jsonl-paths.encodeProjectDir).
function sessionPath(cwd: string, sessionId: string): string {
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return join(fakeHome, ".claude", "projects", enc, `${sessionId}.jsonl`);
}

function writeDanglingTranscript(cwd: string): string {
  const path = sessionPath(cwd, SESSION);
  mkdirSync(dirname(path), { recursive: true });
  const assistant = {
    parentUuid: null,
    isSidechain: false,
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: TOOL_USE_ID, name: "Bash", input: { command: "ls" } }],
    },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: SESSION,
    cwd,
    userType: "external",
    entrypoint: "sdk-ts",
    version: "test",
    gitBranch: "HEAD",
  };
  writeFileSync(path, JSON.stringify(assistant) + "\n", "utf8");
  return path;
}

// Scripted SDK trace: message_start + content_block_start(tool_use) register
// a block, the `assistant` message carries the tool_use, then `result` lands
// with NO intervening `user(tool_result)`. A `tick()` between the assistant
// message and the result lets the injected `prompts-pending` IPC flip
// breakAtNextUser before the short-circuit fires.
async function* makeIterator(cwd: string): AsyncGenerator<Record<string, unknown>> {
  yield { type: "system", subtype: "init", session_id: SESSION };
  yield {
    type: "stream_event",
    session_id: SESSION,
    event: { type: "message_start", message: { id: "msg_1" } },
  };
  yield {
    type: "stream_event",
    session_id: SESSION,
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: TOOL_USE_ID, name: "Bash" },
    },
  };
  yield {
    type: "assistant",
    session_id: SESSION,
    message: {
      id: "msg_1",
      content: [{ type: "tool_use", id: TOOL_USE_ID, name: "Bash", input: { command: "ls" } }],
    },
  };
  // Let the injected prompts-pending IPC land before result.
  await new Promise((r) => setTimeout(r, 30));
  yield {
    type: "result",
    session_id: SESSION,
    stop_reason: "end_turn",
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    total_cost_usd: 0,
  };
  void cwd;
}

describe("worker result short-circuit heals dangling tool_use (FRI-127 §7)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockQueryImpl.mockReset();
    fakeHome = mkdtempSync(join(tmpdir(), "friday-break-heal-w-"));
    workDir = mkdtempSync(join(tmpdir(), "friday-break-heal-cwd-"));
    vi.stubEnv("HOME", fakeHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    try {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("appends the synthetic tool_result AND emits turn-complete (no hang)", async () => {
    const transcriptPath = writeDanglingTranscript(workDir);
    mockQueryImpl.mockImplementation(() => makeIterator(workDir));

    const sent: Record<string, unknown>[] = [];
    const origSend = process.send;
    process.send = ((msg: Record<string, unknown>) => {
      sent.push(msg);
      // As soon as the worker announces the session, arm a pending-injection
      // break so the assistant-boundary defers and the result short-circuit
      // takes the heal branch.
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
          agentName: "heal-agent",
          agentType: "helper",
          mode: "one-shot",
          workingDirectory: workDir,
          systemPrompt: "",
          prompt: "do thing",
          turnId: "t_heal",
          model: "claude-opus-4-7",
          daemonPort: 9999,
        },
      } as never,
      undefined as never,
    );

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (sent.some((m) => m.type === "turn-complete" || m.type === "error")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    process.send = origSend;

    // (b) the worker emitted turn-complete — it did NOT hang on the dangling
    // tool_use.
    expect(sent.some((m) => m.type === "turn-complete")).toBe(true);

    // (a) the JSONL now ends with a synthetic tool_result for the dangling id.
    const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]) as {
      type?: string;
      message?: { content?: Array<{ type?: string; tool_use_id?: string; is_error?: boolean }> };
    };
    expect(last.type).toBe("user");
    expect(last.message?.content?.[0]?.type).toBe("tool_result");
    expect(last.message?.content?.[0]?.tool_use_id).toBe(TOOL_USE_ID);
    expect(last.message?.content?.[0]?.is_error).toBe(true);
  });
});
