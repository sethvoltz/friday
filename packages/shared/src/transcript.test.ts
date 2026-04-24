import { describe, it, expect } from "vitest";
import {
  parseLine,
  parseEntries,
  groupIntoTurns,
  formatTurn,
  formatTurns,
  type RawEntry,
} from "./transcript.js";

// ── Helpers ────────────────────────────────────────────────────

function userEntry(text: string, ts?: string): RawEntry {
  return {
    type: "user",
    uuid: `user-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: ts ?? "2026-04-23T00:00:00.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  };
}

function assistantTextEntry(text: string, model?: string): RawEntry {
  return {
    type: "assistant",
    uuid: `asst-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: "2026-04-23T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      model: model ?? "claude-sonnet-4-6",
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  };
}

function assistantToolUseEntry(name: string, id: string, input: Record<string, unknown>): RawEntry {
  return {
    type: "assistant",
    uuid: `asst-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: "2026-04-23T00:00:01.500Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name, id, input }],
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 50, output_tokens: 30 },
    },
  };
}

function toolResultEntry(toolUseId: string, isError = false): RawEntry {
  return {
    type: "user",
    uuid: `user-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: "2026-04-23T00:00:02.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError }],
    },
  };
}

function thinkingEntry(): RawEntry {
  return {
    type: "assistant",
    uuid: `asst-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: "2026-04-23T00:00:00.500Z",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Let me think about this..." }],
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe("parseLine", () => {
  it("parses valid JSON", () => {
    const entry = parseLine('{"type":"user","message":{"role":"user","content":[]}}');
    expect(entry).not.toBeNull();
    expect(entry!.type).toBe("user");
  });

  it("returns null for empty lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseLine("{broken")).toBeNull();
  });
});

describe("parseEntries", () => {
  it("parses multi-line JSONL", () => {
    const jsonl = [
      '{"type":"queue-operation","operation":"enqueue"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
      "",
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
    ].join("\n");

    const entries = parseEntries(jsonl);
    expect(entries).toHaveLength(3);
    expect(entries[0].type).toBe("queue-operation");
    expect(entries[1].type).toBe("user");
    expect(entries[2].type).toBe("assistant");
  });

  it("skips malformed lines", () => {
    const jsonl = '{"type":"user"}\n{broken}\n{"type":"assistant"}';
    const entries = parseEntries(jsonl);
    expect(entries).toHaveLength(2);
  });
});

describe("groupIntoTurns", () => {
  it("groups a simple prompt-response into one turn", () => {
    const entries = [userEntry("What is 2+2?"), assistantTextEntry("4")];
    const turns = groupIntoTurns(entries);

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe("What is 2+2?");
    expect(turns[0].response).toBe("4");
    expect(turns[0].index).toBe(0);
  });

  it("handles multiple turns", () => {
    const entries = [
      userEntry("First question"),
      assistantTextEntry("First answer"),
      userEntry("Second question"),
      assistantTextEntry("Second answer"),
    ];
    const turns = groupIntoTurns(entries);

    expect(turns).toHaveLength(2);
    expect(turns[0].prompt).toBe("First question");
    expect(turns[0].response).toBe("First answer");
    expect(turns[1].prompt).toBe("Second question");
    expect(turns[1].response).toBe("Second answer");
  });

  it("captures tool calls in a turn", () => {
    const entries = [
      userEntry("Read the file"),
      assistantToolUseEntry("Read", "toolu_123", { file_path: "/tmp/test.ts" }),
      toolResultEntry("toolu_123"),
      assistantTextEntry("Here's the file content"),
    ];
    const turns = groupIntoTurns(entries);

    expect(turns).toHaveLength(1);
    expect(turns[0].toolCalls).toHaveLength(1);
    expect(turns[0].toolCalls[0].name).toBe("Read");
    expect(turns[0].toolCalls[0].id).toBe("toolu_123");
    expect(turns[0].toolCalls[0].input).toEqual({ file_path: "/tmp/test.ts" });
    expect(turns[0].toolCalls[0].isError).toBe(false);
  });

  it("marks errored tool calls", () => {
    const entries = [
      userEntry("Run the test"),
      assistantToolUseEntry("Bash", "toolu_456", { command: "npm test" }),
      toolResultEntry("toolu_456", true),
      assistantTextEntry("The test failed"),
    ];
    const turns = groupIntoTurns(entries);

    expect(turns[0].toolCalls[0].isError).toBe(true);
  });

  it("skips non-message entries (queue-operation, attachment, etc.)", () => {
    const entries: RawEntry[] = [
      { type: "queue-operation", operation: "enqueue" },
      { type: "queue-operation", operation: "dequeue" },
      userEntry("Hello"),
      { type: "attachment", attachment: { type: "skill_listing" } },
      assistantTextEntry("Hi there"),
      { type: "last-prompt", lastPrompt: "Hello" },
    ];
    const turns = groupIntoTurns(entries);

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe("Hello");
  });

  it("handles thinking blocks without crashing", () => {
    const entries = [userEntry("Think about this"), thinkingEntry(), assistantTextEntry("Done")];
    const turns = groupIntoTurns(entries);

    expect(turns).toHaveLength(1);
    expect(turns[0].response).toBe("Done");
  });

  it("accumulates token usage across multiple assistant messages in a turn", () => {
    const entries = [
      userEntry("Do stuff"),
      assistantToolUseEntry("Read", "t1", { file_path: "/a" }),
      toolResultEntry("t1"),
      assistantTextEntry("Done"),
    ];
    const turns = groupIntoTurns(entries);

    // 50+100 input, 30+50 output
    expect(turns[0].usage.input_tokens).toBe(150);
    expect(turns[0].usage.output_tokens).toBe(80);
  });

  it("concatenates multiple assistant text blocks with separator", () => {
    const entries = [
      userEntry("Tell me two things"),
      assistantTextEntry("First thing"),
      assistantTextEntry("Second thing"),
    ];
    const turns = groupIntoTurns(entries);

    expect(turns[0].response).toBe("First thing\n\nSecond thing");
  });

  it("captures model from first assistant message", () => {
    const entries = [userEntry("Hi"), assistantTextEntry("Hello", "claude-opus-4-6")];
    const turns = groupIntoTurns(entries);

    expect(turns[0].model).toBe("claude-opus-4-6");
  });

  it("returns empty array for no entries", () => {
    expect(groupIntoTurns([])).toEqual([]);
  });

  it("handles tool_result user messages without starting a new turn", () => {
    const entries = [
      userEntry("Do something"),
      assistantToolUseEntry("Bash", "t1", { command: "ls" }),
      toolResultEntry("t1"),
      assistantToolUseEntry("Bash", "t2", { command: "pwd" }),
      toolResultEntry("t2"),
      assistantTextEntry("All done"),
    ];
    const turns = groupIntoTurns(entries);

    // Should be ONE turn with two tool calls, not three turns
    expect(turns).toHaveLength(1);
    expect(turns[0].toolCalls).toHaveLength(2);
    expect(turns[0].response).toBe("All done");
  });
});

describe("formatTurn", () => {
  it("formats a basic turn", () => {
    const turn = groupIntoTurns([userEntry("Hello"), assistantTextEntry("Hi")])[0];
    const formatted = formatTurn(turn);

    expect(formatted).toContain("Turn 1");
    expect(formatted).toContain("User: Hello");
    expect(formatted).toContain("Assistant: Hi");
  });

  it("includes tool calls when requested", () => {
    const turn = groupIntoTurns([
      userEntry("Read file"),
      assistantToolUseEntry("Read", "t1", { file_path: "/tmp/x" }),
      toolResultEntry("t1"),
      assistantTextEntry("Contents here"),
    ])[0];

    const withTools = formatTurn(turn, { includeTools: true });
    expect(withTools).toContain("→ Read");

    const withoutTools = formatTurn(turn);
    expect(withoutTools).not.toContain("→ Read");
  });

  it("shows error status on tool calls", () => {
    const turn = groupIntoTurns([
      userEntry("Run test"),
      assistantToolUseEntry("Bash", "t1", { command: "test" }),
      toolResultEntry("t1", true),
      assistantTextEntry("Failed"),
    ])[0];

    const formatted = formatTurn(turn, { includeTools: true });
    expect(formatted).toContain("[ERROR]");
  });
});

describe("formatTurns", () => {
  it("formats multiple turns separated by blank lines", () => {
    const entries = [
      userEntry("Q1"),
      assistantTextEntry("A1"),
      userEntry("Q2"),
      assistantTextEntry("A2"),
    ];
    const turns = groupIntoTurns(entries);
    const formatted = formatTurns(turns);

    expect(formatted).toContain("Turn 1");
    expect(formatted).toContain("Turn 2");
    expect(formatted.split("\n\n").length).toBeGreaterThan(2);
  });
});
