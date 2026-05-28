import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetHooksForTest,
  registerHook,
  runHooks,
  type Skill,
  type SkillMatch,
} from "@friday/shared";
import { skillContextHook } from "./skill-context.js";

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "foo",
    description: "test skill",
    agents: null,
    allowedTools: ["Bash"],
    autoInvoke: false,
    body: "BODY",
    source: "user",
    filePath: "/tmp/foo.md",
    ...overrides,
  };
}

beforeEach(() => {
  __resetHooksForTest();
});

afterEach(() => {
  __resetHooksForTest();
});

describe("skill-context hook (FRI-107)", () => {
  it("emits appendSystemPrompt and allowedToolsOverride when ctx.skillMatch is present", async () => {
    const skillMatch: SkillMatch = {
      skill: makeSkill(),
      userText: "args",
    };

    const result = await skillContextHook({
      intent: "args",
      intentTag: "user_chat",
      body: "args",
      agentType: "orchestrator",
      skillMatch,
    });

    expect(result).toEqual({
      appendSystemPrompt: '<skill-context name="foo">\nBODY\n</skill-context>',
      allowedToolsOverride: ["Bash"],
    });
  });

  it("emits appendSystemPrompt without allowedToolsOverride when skill has empty allowedTools", async () => {
    const skillMatch: SkillMatch = {
      skill: makeSkill({ allowedTools: [] }),
      userText: "args",
    };

    const result = await skillContextHook({
      intent: "args",
      intentTag: "user_chat",
      body: "args",
      agentType: "orchestrator",
      skillMatch,
    });

    expect(result).toEqual({
      appendSystemPrompt: '<skill-context name="foo">\nBODY\n</skill-context>',
      allowedToolsOverride: undefined,
    });
  });

  it("emits appendSystemPrompt without allowedToolsOverride when skill.allowedTools is null", async () => {
    const skillMatch: SkillMatch = {
      skill: makeSkill({ allowedTools: null as unknown as string[] }),
      userText: "args",
    };

    const result = await skillContextHook({
      intent: "args",
      intentTag: "user_chat",
      body: "args",
      agentType: "orchestrator",
      skillMatch,
    });

    expect(result).toEqual({
      appendSystemPrompt: '<skill-context name="foo">\nBODY\n</skill-context>',
      allowedToolsOverride: undefined,
    });
  });

  it("returns void when ctx.skillMatch is undefined", async () => {
    const result = await skillContextHook({
      intent: "x",
      intentTag: "user_chat",
      body: "x",
      agentType: "orchestrator",
    });

    expect(result).toBeUndefined();
  });

  // FRI-123: the original two integration tests against the prior
  // dispatch-composer entry point are rewritten per the ticket's
  // BLOCKED-ON-OWNER default (Option A) — assert the runHooks
  // composition surface directly, without dragging in a test-DB.
  // The end-to-end stitching (skill body → systemPrompt +
  // allowedToolsOverride routing) is exercised in
  // `prompts/build-dispatch-prompt.test.ts` golden tests.

  it("runHooks(before_prompt_build, ctx) yields skillContextHook's result when ctx has a skillMatch", async () => {
    registerHook("before_prompt_build", skillContextHook);

    const results = await runHooks("before_prompt_build", {
      intent: "args",
      intentTag: "user_chat",
      body: "args",
      agentType: "orchestrator",
      skillMatch: {
        skill: makeSkill({ name: "deploy", body: "ship it", allowedTools: ["Bash", "Read"] }),
        userText: "args",
      },
    });

    expect(results).toEqual([
      {
        appendSystemPrompt: '<skill-context name="deploy">\nship it\n</skill-context>',
        allowedToolsOverride: ["Bash", "Read"],
      },
    ]);
  });

  it("runHooks(before_prompt_build, ctx) skips the handler when no skillMatch is on ctx", async () => {
    registerHook("before_prompt_build", skillContextHook);

    const results = await runHooks("before_prompt_build", {
      intent: "plain user query",
      intentTag: "user_chat",
      body: "plain user query",
      agentType: "orchestrator",
    });

    // The handler returns void when skillMatch is absent; runHooks
    // skips void returns, so the result array stays empty.
    expect(results).toEqual([]);
  });
});
