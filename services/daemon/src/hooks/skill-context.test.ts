import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetHooksForTest, registerHook, type Skill, type SkillMatch } from "@friday/shared";
import { composeDispatchPrompt } from "../agent/compose-dispatch-prompt.js";
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

  it("integration: composeDispatchPrompt + skillContextHook routes skill body to systemPrompt and allowedToolsOverride", async () => {
    registerHook("before_prompt_build", skillContextHook);

    const { body, systemPrompt, allowedToolsOverride } = await composeDispatchPrompt({
      intentText: "args",
      intentTag: "user_chat",
      body: "args",
      agentType: "orchestrator",
      baseSystemPrompt: "you are a helpful agent",
      skillMatch: {
        skill: makeSkill({ name: "deploy", body: "ship it", allowedTools: ["Bash", "Read"] }),
        userText: "args",
      },
    });

    expect(body).toBe("args");
    expect(body).not.toContain("<skill-context");
    expect(systemPrompt).toBe(
      'you are a helpful agent\n\n<skill-context name="deploy">\nship it\n</skill-context>',
    );
    expect(allowedToolsOverride).toEqual(["Bash", "Read"]);
  });

  it("integration: composeDispatchPrompt + skillContextHook leaves systemPrompt untouched when no skill match", async () => {
    registerHook("before_prompt_build", skillContextHook);

    const { systemPrompt, allowedToolsOverride } = await composeDispatchPrompt({
      intentText: "plain user query",
      intentTag: "user_chat",
      body: "plain user query",
      agentType: "orchestrator",
      baseSystemPrompt: "base",
    });

    expect(systemPrompt).toBe("base");
    expect(allowedToolsOverride).toBeUndefined();
  });
});
