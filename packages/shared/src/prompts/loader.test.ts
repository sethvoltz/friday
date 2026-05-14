import { describe, expect, it } from "vitest";
import {
  composeSystemPrompt,
  readPromptStack,
  renderIdentityBlock,
} from "./loader.js";

describe("renderIdentityBlock (FRI-11)", () => {
  it("pins the agent's literal name and parent name into the prompt", () => {
    const block = renderIdentityBlock({
      agentName: "mail-routing-parent-child",
      agentType: "builder",
      parentName: "friday",
    });
    expect(block).toContain("`mail-routing-parent-child`");
    expect(block).toContain("`friday`");
    expect(block).toContain('mail_send({to: "friday"');
    expect(block).toContain('mail_send({to: "parent"');
    expect(block).toMatch(/Never use role names/);
  });

  it("omits parent guidance when the agent has no parent", () => {
    const block = renderIdentityBlock({
      agentName: "friday",
      agentType: "orchestrator",
    });
    expect(block).toContain("`friday`");
    expect(block).not.toMatch(/Your parent agent/);
    expect(block).toMatch(/no parent agent/);
  });
});

describe("composeSystemPrompt with identity", () => {
  it("builder prompt includes the literal parent name when identity is passed", () => {
    const stack = readPromptStack("builder", []);
    const composed = composeSystemPrompt(stack, {
      agentName: "builder-007",
      agentType: "builder",
      parentName: "friday",
    });
    expect(composed).toContain("# Identity");
    expect(composed).toContain("`builder-007`");
    expect(composed).toContain("Your parent agent is named `friday`");
    expect(composed).toContain("Role: Builder");
  });

  it("helper prompt includes the parent name", () => {
    const stack = readPromptStack("helper", []);
    const composed = composeSystemPrompt(stack, {
      agentName: "helper-1",
      agentType: "helper",
      parentName: "friday",
    });
    expect(composed).toContain("Your parent agent is named `friday`");
  });

  it("bare prompt without parent emits 'no parent agent' line", () => {
    const stack = readPromptStack("bare", []);
    const composed = composeSystemPrompt(stack, {
      agentName: "scratch-1",
      agentType: "bare",
    });
    expect(composed).toMatch(/no parent agent/);
  });

  it("omits the identity block entirely when no identity is provided", () => {
    const stack = readPromptStack("orchestrator", []);
    const composed = composeSystemPrompt(stack);
    expect(composed).not.toContain("# Identity");
  });
});
