import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetHooksForTest,
  registerHook,
  runHooks,
  setHooksLogger,
  type HookEvent,
  type HooksLogger,
  type SkillMatch,
} from "./index.js";
import type { Skill } from "../skills.js";

function makeLogger(): { logger: HooksLogger; calls: ReturnType<typeof vi.fn> } {
  const calls = vi.fn();
  const logger: HooksLogger = { log: calls };
  return { logger, calls };
}

afterEach(() => {
  __resetHooksForTest();
});

describe("hook registry", () => {
  it("registerHook returns an unregister thunk that removes only that handler", async () => {
    const results: number[] = [];
    const off1 = registerHook("before_prompt_build", async () => {
      results.push(1);
    });
    registerHook("before_prompt_build", async () => {
      results.push(2);
    });

    off1();

    await runHooks("before_prompt_build", {
      intent: "x",
      intentTag: "user_chat",
      body: "",
      agentType: "orchestrator",
    });

    expect(results).toEqual([2]);
  });

  it("runHooks executes handlers in registration order", async () => {
    const arr: number[] = [];
    registerHook("before_prompt_build", async () => {
      arr.push(0);
    });
    registerHook("before_prompt_build", async () => {
      arr.push(1);
    });
    registerHook("before_prompt_build", async () => {
      arr.push(2);
    });

    await runHooks("before_prompt_build", {
      intent: "x",
      intentTag: "user_chat",
      body: "",
      agentType: "orchestrator",
    });

    expect(arr).toEqual([0, 1, 2]);
  });

  it("before_prompt_build composes handler outputs", async () => {
    registerHook("before_prompt_build", async () => ({ prependBody: "A" }));
    registerHook("before_prompt_build", async () => ({
      appendSystemPrompt: "B",
    }));

    const results = await runHooks("before_prompt_build", {
      intent: "x",
      intentTag: "user_chat",
      body: "",
      agentType: "orchestrator",
    });

    expect(results).toEqual([{ prependBody: "A" }, { appendSystemPrompt: "B" }]);
  });

  it("before_tool_call short-circuits on first deny", async () => {
    registerHook("before_tool_call", async () => ({
      deny: { reason: "blocked" },
    }));
    const spy = vi.fn(async () => undefined);
    registerHook("before_tool_call", spy);

    const results = await runHooks("before_tool_call", {
      workspacePath: "/tmp/wt",
      toolName: "Bash",
      toolInput: {},
    });

    expect(spy).not.toHaveBeenCalled();
    expect(results).toEqual([{ deny: { reason: "blocked" } }]);
  });

  it("before_prompt_build error policy: log-and-continue", async () => {
    const { logger, calls } = makeLogger();
    setHooksLogger(logger);

    registerHook("before_prompt_build", async () => {
      throw new Error("boom");
    });
    registerHook("before_prompt_build", async () => ({
      appendSystemPrompt: "C",
    }));

    const results = await runHooks("before_prompt_build", {
      intent: "x",
      intentTag: "user_chat",
      body: "",
      agentType: "orchestrator",
    });

    expect(calls).toHaveBeenCalledWith(
      "error",
      "hooks.handler.error",
      expect.objectContaining({
        event: "before_prompt_build",
        handlerIndex: 0,
        message: "boom",
      }),
    );
    expect(results).toEqual([{ appendSystemPrompt: "C" }]);
  });

  it("before_tool_call error policy: log-and-deny", async () => {
    const { logger, calls } = makeLogger();
    setHooksLogger(logger);

    registerHook("before_tool_call", async () => {
      throw new Error("boom");
    });

    const results = await runHooks("before_tool_call", {
      workspacePath: "/tmp/wt",
      toolName: "Bash",
      toolInput: {},
    });

    expect(calls).toHaveBeenCalledWith(
      "error",
      "hooks.handler.error",
      expect.objectContaining({
        event: "before_tool_call",
        handlerIndex: 0,
        message: "boom",
      }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].deny).toBeDefined();
    expect(results[0].deny!.reason.length).toBeGreaterThan(0);
  });

  it("__resetHooksForTest clears all registrations", async () => {
    registerHook("agent:bootstrap", async () => ({}));
    registerHook("before_prompt_build", async () => ({}));
    registerHook("before_tool_call", async () => ({}));
    registerHook("before_compaction", async () => ({}));

    __resetHooksForTest();

    expect(
      await runHooks("agent:bootstrap", {
        agentName: "x",
        agentType: "builder",
        workingDirectory: "/tmp",
      }),
    ).toEqual([]);
    expect(
      await runHooks("before_prompt_build", {
        intent: "",
        intentTag: "user_chat",
        body: "",
        agentType: "orchestrator",
      }),
    ).toEqual([]);
    expect(
      await runHooks("before_tool_call", {
        workspacePath: "/tmp",
        toolName: undefined,
        toolInput: {},
      }),
    ).toEqual([]);
    expect(
      await runHooks("before_compaction", {
        sessionId: "s",
        transcriptPath: "/tmp/t",
        trigger: "auto",
      }),
    ).toEqual([]);
  });

  it("agent:bootstrap ctx includes branch field", async () => {
    let seenBranch: string | undefined;
    registerHook("agent:bootstrap", async (ctx) => {
      seenBranch = ctx.branch;
    });

    await runHooks("agent:bootstrap", {
      agentName: "x",
      agentType: "builder",
      workingDirectory: "/tmp/wt",
      branch: "main",
    });

    expect(seenBranch).toBe("main");
  });

  it("before_prompt_build ctx includes skillMatch field", async () => {
    const skill: Skill = {
      name: "foo",
      description: "test skill",
      agents: null,
      allowedTools: [],
      autoInvoke: false,
      body: "x",
      source: "user",
      filePath: "/tmp/foo.md",
    };
    const skillMatch: SkillMatch = { skill, userText: "args" };

    let seenName: string | undefined;
    let seenUserText: string | undefined;
    registerHook("before_prompt_build", async (ctx) => {
      seenName = ctx.skillMatch?.skill.name;
      seenUserText = ctx.skillMatch?.userText;
    });

    await runHooks("before_prompt_build", {
      intent: "hi",
      intentTag: "user_chat",
      body: "hi",
      agentType: "orchestrator",
      skillMatch,
    });

    expect(seenName).toBe("foo");
    expect(seenUserText).toBe("args");
  });

  it("HookEvent literal values are pinned", async () => {
    const events: HookEvent[] = [
      "agent:bootstrap",
      "before_prompt_build",
      "before_tool_call",
      "before_compaction",
    ];
    for (const event of events) {
      expect([
        "agent:bootstrap",
        "before_prompt_build",
        "before_tool_call",
        "before_compaction",
      ]).toContain(event);
    }
  });
});
