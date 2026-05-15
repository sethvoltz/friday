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

describe("default protocols by agent type", () => {
  it("orchestrator stack auto-includes the memory protocol", () => {
    const stack = readPromptStack("orchestrator", []);
    expect(stack.protocols).toContain("# Protocol: Memory");
    expect(stack.protocols).toContain("Saving — make it reflexive");
  });

  it("scheduled stack auto-includes the memory protocol", () => {
    const stack = readPromptStack("scheduled", []);
    expect(stack.protocols).toContain("# Protocol: Memory");
  });

  it("bare stack auto-includes the memory protocol", () => {
    const stack = readPromptStack("bare", []);
    expect(stack.protocols).toContain("# Protocol: Memory");
  });

  it("builder stack does NOT include the memory protocol (builders are read-only)", () => {
    const stack = readPromptStack("builder", []);
    expect(stack.protocols).not.toContain("# Protocol: Memory");
  });

  it("helper stack does NOT include the memory protocol", () => {
    const stack = readPromptStack("helper", []);
    expect(stack.protocols).not.toContain("# Protocol: Memory");
  });

  it("does not duplicate the memory protocol when caller passes it explicitly", () => {
    const stack = readPromptStack("orchestrator", ["memory"]);
    const occurrences = stack.protocols.split("# Protocol: Memory").length - 1;
    expect(occurrences).toBe(1);
  });
});
