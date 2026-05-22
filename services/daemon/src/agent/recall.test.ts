import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetHooksForTest, registerHook } from "@friday/shared";
import { composeDispatchPrompt } from "./compose-dispatch-prompt.js";

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
    const { memoryRecallHook } = await import("../hooks/memory-recall-hook.js");

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
    const { memoryRecallHook } = await import("../hooks/memory-recall-hook.js");

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
    const { memoryRecallHook } = await import("../hooks/memory-recall-hook.js");

    const result = await memoryRecallHook({
      intent: "query",
      intentTag: "mail",
      body: "fallback path body",
      agentType: "orchestrator",
    });

    expect(result).toBeUndefined();
  });

  it("composeDispatchPrompt routes appendSystemPrompt into systemPrompt and leaves body untouched", async () => {
    registerHook("before_prompt_build", async () => ({
      appendSystemPrompt: "<memory-context>\nrelevant fact\n</memory-context>",
    }));

    const { body, systemPrompt } = await composeDispatchPrompt({
      intentText: "user query",
      intentTag: "user_chat",
      body: "actual user body",
      agentType: "orchestrator",
      baseSystemPrompt: "you are a helpful agent",
    });

    expect(body).toBe("actual user body");
    expect(body).not.toContain("<memory-context>");
    expect(systemPrompt).toBe(
      "you are a helpful agent\n\n<memory-context>\nrelevant fact\n</memory-context>",
    );
  });

  it("composeDispatchPrompt leaves body and systemPrompt unchanged when no handlers are registered", async () => {
    const { body, systemPrompt } = await composeDispatchPrompt({
      intentText: "x",
      intentTag: "scheduled",
      body: "body",
      agentType: "scheduled",
      baseSystemPrompt: "base",
    });

    expect(body).toBe("body");
    expect(systemPrompt).toBe("base");
  });

  it("composeDispatchPrompt threads skillMatch through hook ctx", async () => {
    let seenName: string | undefined;
    let seenUserText: string | undefined;
    registerHook("before_prompt_build", async (ctx) => {
      seenName = ctx.skillMatch?.skill.name;
      seenUserText = ctx.skillMatch?.userText;
    });

    await composeDispatchPrompt({
      intentText: "args",
      intentTag: "user_chat",
      body: "args",
      agentType: "orchestrator",
      baseSystemPrompt: "base",
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

  it("composeDispatchPrompt propagates allowedToolsOverride from handler results", async () => {
    registerHook("before_prompt_build", async () => ({
      allowedToolsOverride: ["Read", "Grep"],
    }));

    const { allowedToolsOverride } = await composeDispatchPrompt({
      intentText: "x",
      intentTag: "user_chat",
      body: "x",
      agentType: "orchestrator",
      baseSystemPrompt: "base",
    });

    expect(allowedToolsOverride).toEqual(["Read", "Grep"]);
  });
});
