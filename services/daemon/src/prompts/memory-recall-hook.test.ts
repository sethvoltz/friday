/**
 * FRI-123: tests for `memoryRecallHook` + `safeRecall` (moved from
 * `services/daemon/src/agent/recall.test.ts`). The middle
 * dispatch-composer integration describe block from the old file
 * is rewritten to call `runHooks("before_prompt_build", ctx)`
 * directly — those tests pin the hook composition surface and
 * shouldn't drag in a test-DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetHooksForTest, registerHook, runHooks } from "@friday/shared";

beforeEach(() => {
  __resetHooksForTest();
});

afterEach(() => {
  __resetHooksForTest();
  vi.resetModules();
});

describe("memory recall hook (FRI-89)", () => {
  it("memoryRecallHook returns void when memory is empty so the dispatch site appends nothing", async () => {
    vi.resetModules();
    vi.doMock("@friday/memory", () => ({
      buildAutoRecallBlock: async () => "",
    }));
    const { memoryRecallHook } = await import("./memory-recall-hook.js");

    const result = await memoryRecallHook({
      intent: "query",
      intentTag: "user_chat",
      body: "user body",
      agentType: "orchestrator",
    });

    expect(result).toBeUndefined();
  });

  it("memoryRecallHook surfaces the <memory-context> block via appendSystemPrompt when memory has hits", async () => {
    vi.resetModules();
    vi.doMock("@friday/memory", () => ({
      buildAutoRecallBlock: async () => "<memory-context>\nrelevant fact\n</memory-context>",
    }));
    const { memoryRecallHook } = await import("./memory-recall-hook.js");

    const result = await memoryRecallHook({
      intent: "query",
      intentTag: "user_chat",
      body: "user body",
      agentType: "orchestrator",
    });

    expect(result).toEqual({
      appendSystemPrompt: "<memory-context>\nrelevant fact\n</memory-context>",
    });
  });

  it("memoryRecallHook returns void (best-effort) when buildAutoRecallBlock throws", async () => {
    vi.resetModules();
    vi.doMock("@friday/memory", () => ({
      buildAutoRecallBlock: () => {
        throw new Error("memory backend down");
      },
    }));
    const { memoryRecallHook } = await import("./memory-recall-hook.js");

    const result = await memoryRecallHook({
      intent: "query",
      intentTag: "mail",
      body: "fallback path body",
      agentType: "orchestrator",
    });

    expect(result).toBeUndefined();
  });
});

describe("before_prompt_build hook composition surface (FRI-123)", () => {
  // Rewritten per the FRI-123 ticket's BLOCKED-ON-OWNER default
  // (Option A): assert the `runHooks` composition surface directly
  // — the entry point that USES this composition lives in
  // `prompts/build-dispatch-prompt.ts` and its golden tests cover
  // the end-to-end stitching.

  it("runHooks returns the appendSystemPrompt payload that handlers produce", async () => {
    registerHook("before_prompt_build", async () => ({
      appendSystemPrompt: "<memory-context>\nrelevant fact\n</memory-context>",
    }));

    const results = await runHooks("before_prompt_build", {
      intent: "user query",
      intentTag: "user_chat",
      body: "actual user body",
      agentType: "orchestrator",
    });

    expect(results).toEqual([
      { appendSystemPrompt: "<memory-context>\nrelevant fact\n</memory-context>" },
    ]);
  });

  it("runHooks returns [] when no handlers are registered", async () => {
    const results = await runHooks("before_prompt_build", {
      intent: "x",
      intentTag: "scheduled",
      body: "body",
      agentType: "scheduled",
    });
    expect(results).toEqual([]);
  });

  it("threads skillMatch through ctx to the handler", async () => {
    let seenName: string | undefined;
    let seenUserText: string | undefined;
    registerHook("before_prompt_build", async (ctx) => {
      seenName = ctx.skillMatch?.skill.name;
      seenUserText = ctx.skillMatch?.userText;
    });

    await runHooks("before_prompt_build", {
      intent: "args",
      intentTag: "user_chat",
      body: "args",
      agentType: "orchestrator",
      skillMatch: {
        skill: {
          name: "skill-foo",
          description: "test",
          agents: null,
          allowedTools: [],
          autoInvoke: false,
          body: "skill body",
          source: "user",
          filePath: "/tmp/foo.md",
        },
        userText: "args",
      },
    });

    expect(seenName).toBe("skill-foo");
    expect(seenUserText).toBe("args");
  });

  it("propagates allowedToolsOverride in handler results", async () => {
    registerHook("before_prompt_build", async () => ({
      allowedToolsOverride: ["Read", "Grep"],
    }));

    const results = await runHooks("before_prompt_build", {
      intent: "x",
      intentTag: "user_chat",
      body: "x",
      agentType: "orchestrator",
    });

    expect(results).toEqual([{ allowedToolsOverride: ["Read", "Grep"] }]);
  });
});

describe("safeRecall listener-ready gate (33sq)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("fails open (returns '') and logs memory.recall.listener-timeout when listener does not become ready within 3 s", async () => {
    vi.useFakeTimers();
    vi.doMock("../memory/listener.js", () => ({
      whenMemoryListenerReady: () => new Promise<void>(() => {}), // never resolves
    }));
    const buildMock = vi.fn().mockResolvedValue("should not be reached");
    vi.doMock("@friday/memory", () => ({ buildAutoRecallBlock: buildMock }));
    const logMock = vi.fn();
    vi.doMock("../log.js", () => ({ logger: { log: logMock } }));

    const { safeRecall } = await import("./memory-recall-hook.js");

    const resultPromise = safeRecall("test query", "user_chat");
    await vi.advanceTimersByTimeAsync(3_001);
    const result = await resultPromise;

    expect(result).toBe("");
    expect(buildMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith("warn", "memory.recall.listener-timeout", {
      intent: "user_chat",
    });
  });

  it("proceeds to recall when listener is already ready", async () => {
    vi.doMock("../memory/listener.js", () => ({
      whenMemoryListenerReady: () => Promise.resolve(),
    }));
    vi.doMock("@friday/memory", () => ({
      buildAutoRecallBlock: async () => "<memory-context>test</memory-context>",
    }));

    const { safeRecall } = await import("./memory-recall-hook.js");
    const result = await safeRecall("test query", "user_chat");

    expect(result).toBe("<memory-context>test</memory-context>");
  });

  it("falls back to '' when listener resolves but buildAutoRecallBlock throws", async () => {
    vi.doMock("../memory/listener.js", () => ({
      whenMemoryListenerReady: () => Promise.resolve(),
    }));
    vi.doMock("@friday/memory", () => ({
      buildAutoRecallBlock: () => {
        throw new Error("db error");
      },
    }));
    const logMock = vi.fn();
    vi.doMock("../log.js", () => ({ logger: { log: logMock } }));

    const { safeRecall } = await import("./memory-recall-hook.js");
    const result = await safeRecall("test query", "mail");

    expect(result).toBe("");
    expect(logMock).toHaveBeenCalledWith("warn", "memory.recall.error", {
      intent: "mail",
      message: "db error",
    });
  });
});
