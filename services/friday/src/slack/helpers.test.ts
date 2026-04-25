import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  chunkMessage,
  buildBatchPrompt,
  buildBlockquote,
  formatErrorResponse,
  buildSessionFields,
} from "./helpers.js";
import type { RuntimeConfig } from "../config.js";

// Minimal config factory for testing
function makeConfig(overrides: Record<string, any> = {}): RuntimeConfig {
  return {
    slack: { orchestratorChannelId: "C-orch" },
    agent: {
      workingDirectory: "/tmp",
      allowedTools: ["Read"],
      permissionMode: "auto-accept",
      model: "claude-sonnet-4-6",
      ...overrides.agent,
    },
    independentAgent: overrides.independentAgent,
    slack_formatting: {
      maxMessageLength: 4000,
      streamingEnabled: true,
      emojiReactions: {
        processing: "eyes",
        queued: "clock1",
        error: "x",
        complete: null,
      },
    },
    monitoring: {
      usageLogFile: "/tmp/usage.jsonl",
      warnAtPercentOfDailyLimit: 80,
    },
  } as RuntimeConfig;
}

describe("buildSystemPrompt", () => {
  it("orchestrator gets channel context and role prime", () => {
    const config = makeConfig();
    const result = buildSystemPrompt(config, "orchestrator", "C123", "/tmp");

    expect(result).toBeDefined();
    expect(result!.type).toBe("preset");
    expect(result!.append).toContain("C123");
    expect(result!.append).toContain("You are the Orchestrator");
  });

  it("orchestrator includes custom prompt after prime", () => {
    const config = makeConfig({
      agent: { systemPrompt: "CUSTOM_SIGIL_XYZ" },
    });
    const result = buildSystemPrompt(config, "orchestrator", "C123", "/tmp");

    expect(result!.append).toContain("You are the Orchestrator");
    expect(result!.append).toContain("CUSTOM_SIGIL_XYZ");
    // Custom prompt comes after the prime
    const primeIdx = result!.append.indexOf("You are the Orchestrator");
    const customIdx = result!.append.indexOf("CUSTOM_SIGIL_XYZ");
    expect(customIdx).toBeGreaterThan(primeIdx);
  });

  it("builder gets builder role prime", () => {
    const config = makeConfig();
    const result = buildSystemPrompt(config, "builder", "C123", "/tmp");

    expect(result).toBeDefined();
    expect(result!.append).toContain("You are Builder");
  });

  it("helper gets helper role prime", () => {
    const config = makeConfig();
    const result = buildSystemPrompt(config, "helper", "C123", "/tmp");

    expect(result).toBeDefined();
    expect(result!.append).toContain("You are Helper");
  });

  it("bare session includes memory guidance without custom prompt", () => {
    const config = makeConfig();
    const result = buildSystemPrompt(config, "bare", "C999", "/tmp");

    expect(result).toBeDefined();
    expect(result!.append).toContain("Memory");
    expect(result!.append).toContain("memory_save");
    expect(result!.append).toContain("C999");
  });

  it("bare session returns preset with custom prompt", () => {
    const config = makeConfig({
      independentAgent: { systemPrompt: "Be helpful." },
    });
    const result = buildSystemPrompt(config, "bare", "C999", "/tmp");

    expect(result).toBeDefined();
    expect(result!.append).toContain("C999");
    expect(result!.append).toContain("Be helpful.");
  });

  it("selects correct config per session type", () => {
    const config = makeConfig({
      agent: { systemPrompt: "ORCH_CUSTOM_SIGIL" },
      independentAgent: { systemPrompt: "BARE_CUSTOM_SIGIL" },
    });

    const orchResult = buildSystemPrompt(config, "orchestrator", "C1", "/tmp");
    expect(orchResult!.append).toContain("ORCH_CUSTOM_SIGIL");
    expect(orchResult!.append).not.toContain("BARE_CUSTOM_SIGIL");

    const bareResult = buildSystemPrompt(config, "bare", "C2", "/tmp");
    expect(bareResult!.append).toContain("BARE_CUSTOM_SIGIL");
    expect(bareResult!.append).not.toContain("ORCH_CUSTOM_SIGIL");
  });
});

describe("chunkMessage", () => {
  it("returns single chunk for short messages", () => {
    expect(chunkMessage("hello", 100)).toEqual(["hello"]);
  });

  it("returns single chunk at exact limit", () => {
    const text = "x".repeat(100);
    expect(chunkMessage(text, 100)).toEqual([text]);
  });

  it("splits at newline when possible", () => {
    const chunks = chunkMessage("aaa\nbbb\nccc", 7);
    // lastIndexOf("\n", 7) finds the second newline, so split is "aaa\nbbb" then "ccc"
    expect(chunks).toEqual(["aaa\nbbb", "ccc"]);
  });

  it("splits at space when no newline available", () => {
    const chunks = chunkMessage("aaaa bbbb cccc", 9);
    expect(chunks).toEqual(["aaaa bbbb", "cccc"]);
  });

  it("hard-breaks when no space or newline available", () => {
    const text = "a".repeat(20);
    const chunks = chunkMessage(text, 8);

    expect(chunks).toEqual(["a".repeat(8), "a".repeat(8), "a".repeat(4)]);
  });

  it("all chunks respect maxLength", () => {
    const text = "word ".repeat(50);
    const chunks = chunkMessage(text, 30);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
  });

  it("preserves all content and ordering across chunks", () => {
    // Use newline-separated lines so split + trimStart doesn't eat content
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}-content`);
    const text = lines.join("\n");
    const chunks = chunkMessage(text, 40);

    // Concatenating chunks should reproduce original (newlines become split points
    // and trimStart eats the newline, so rejoin with \n)
    const reassembled = chunks.join("\n");
    expect(reassembled).toBe(text);
  });

  it("never drops or reorders content in word-wrapped text", () => {
    const text = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    const chunks = chunkMessage(text, 20);

    // Each word appears exactly once across all chunks, in order
    const allText = chunks.join(" ");
    const originalWords = text.split(" ");
    const resultWords = allText.split(/\s+/);

    expect(resultWords).toEqual(originalWords);
  });

  it("handles empty string", () => {
    expect(chunkMessage("", 100)).toEqual([""]);
  });
});

describe("buildBatchPrompt", () => {
  it("returns single message as-is", () => {
    expect(buildBatchPrompt(["hello"])).toBe("hello");
  });

  it("joins multiple messages with double newlines", () => {
    expect(buildBatchPrompt(["msg1", "msg2", "msg3"])).toBe(
      "msg1\n\nmsg2\n\nmsg3"
    );
  });
});

describe("buildBlockquote", () => {
  it("wraps single-line messages in blockquote", () => {
    expect(buildBlockquote(["hello"])).toBe("> hello");
  });

  it("wraps each line of multi-line messages", () => {
    expect(buildBlockquote(["line1\nline2"])).toBe("> line1\n> line2");
  });

  it("separates multiple messages with double newlines", () => {
    expect(buildBlockquote(["msg1", "msg2"])).toBe("> msg1\n\n> msg2");
  });

  it("handles multi-line messages in a batch", () => {
    expect(buildBlockquote(["a\nb", "c\nd"])).toBe("> a\n> b\n\n> c\n> d");
  });
});

describe("formatErrorResponse", () => {
  it("formats error without quote", () => {
    expect(formatErrorResponse("something failed", null)).toBe(
      ":radioactive_sign: _something failed_"
    );
  });

  it("formats error with blockquote", () => {
    const result = formatErrorResponse("oops", "> original message");
    expect(result).toBe("> original message\n\n:radioactive_sign: _oops_");
  });
});

describe("buildSessionFields", () => {
  it("builds fields with stats", () => {
    const stats = {
      turnCount: 10,
      totalCostUsd: 0.1234,
      cacheHitRate: 85,
      firstTurnAt: "2026-04-22T10:00:00Z",
      totalDurationMs: 60000,
    };
    const fields = buildSessionFields(
      "abcdef12345678",
      stats,
      "/home/user",
      () => "2h ago",
      () => "1m 0s"
    );

    expect(fields).toContain("*Session*  `abcdef12…`");
    expect(fields).toContain("*Turns*  10");
    expect(fields).toContain("*Cost*  $0.1234");
    expect(fields).toContain("*Cache hit rate*  85%");
    expect(fields).toContain("*Started*  2h ago");
    expect(fields).toContain("*Agent time*  1m 0s");
    expect(fields).toContain("*Working dir*  `/home/user`");
  });

  it("builds fields without stats (null)", () => {
    const fields = buildSessionFields(
      "abcdef12345678",
      null,
      "/home/user",
      () => "never",
      () => "0s"
    );

    expect(fields).toContain("*Turns*  —");
    expect(fields).toContain("*Cost*  —");
    expect(fields).toContain("*Cache hit rate*  —");
  });
});
