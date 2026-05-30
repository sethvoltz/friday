import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composeSystemPrompt,
  readPromptStack,
  renderIdentityBlock,
  renderLocalDatetime,
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

describe("SOUL is identity-neutral; orchestrator owns 'You are Friday' (FRI-127)", () => {
  const ORCH_FRAMING = "You are Friday: the user's personal AI orchestrator";

  it.each(["helper", "builder", "bare", "scheduled"] as const)(
    "%s composed prompt does NOT carry the orchestrator framing",
    (agentType) => {
      const stack = readPromptStack(agentType, []);
      const composed = composeSystemPrompt(stack, {
        agentName: "child-1",
        agentType,
        parentName: "friday",
      });
      expect(composed.includes(ORCH_FRAMING)).toBe(false);
    },
  );

  it("orchestrator composed prompt carries the framing exactly once", () => {
    const stack = readPromptStack("orchestrator", []);
    const composed = composeSystemPrompt(stack, {
      agentName: "friday",
      agentType: "orchestrator",
    });
    const occurrences = composed.split(ORCH_FRAMING).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("composeSystemPrompt pinned facts (FRI-61)", () => {
  it("includes the pinned-facts block verbatim between Identity and agentBase", () => {
    const stack = readPromptStack("orchestrator", []);
    const pinnedFacts = "# Pinned facts\n\n- **repo**: lives at /tmp/test";
    const composed = composeSystemPrompt(
      stack,
      { agentName: "friday", agentType: "orchestrator" },
      pinnedFacts,
    );
    expect(composed).toContain(pinnedFacts);
    // Order: Identity must precede pinned-facts, which must precede agentBase.
    const idxIdentity = composed.indexOf("# Identity");
    const idxPinned = composed.indexOf("# Pinned facts");
    const idxAgentBase = composed.indexOf(stack.agentBase);
    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxPinned).toBeGreaterThan(idxIdentity);
    expect(idxAgentBase).toBeGreaterThan(idxPinned);
  });

  it("omits the pinned-facts block when arg is undefined", () => {
    const stack = readPromptStack("orchestrator", []);
    const composed = composeSystemPrompt(stack, {
      agentName: "friday",
      agentType: "orchestrator",
    });
    expect(composed).not.toContain("# Pinned facts");
  });

  it("omits the pinned-facts block when arg is the empty string", () => {
    const stack = readPromptStack("orchestrator", []);
    const composed = composeSystemPrompt(
      stack,
      { agentName: "friday", agentType: "orchestrator" },
      "",
    );
    expect(composed).not.toContain("# Pinned facts");
  });

  it("renders pinned facts even when identity is omitted", () => {
    const stack = readPromptStack("orchestrator", []);
    const pinnedFacts = "# Pinned facts\n\n- **x**: y";
    const composed = composeSystemPrompt(stack, undefined, pinnedFacts);
    expect(composed).toContain(pinnedFacts);
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

describe("pr-links protocol (FRI-131, Option A — unconditional)", () => {
  const PR_LINKS_HEADER = "# Protocol: PR & Issue Links";

  // AC#2 — fragment loads for every agent type, with NO env precondition.
  it.each(["orchestrator", "builder", "helper", "scheduled", "bare"] as const)(
    "%s stack auto-includes the pr-links protocol",
    (agentType) => {
      const stack = readPromptStack(agentType, []);
      expect(stack.protocols).toContain(PR_LINKS_HEADER);
    },
  );

  // AC#3 — unconditional (no GitHub env) AND the builder-excludes-memory
  // invariant is untouched.
  it("loads for builder with no GitHub-related env, and does not regress the builder-excludes-memory invariant", () => {
    const hadGhToken = process.env.GH_TOKEN;
    const hadGithubToken = process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const stack = readPromptStack("builder", []);
      // Unconditional: present even with no GitHub signal in the environment.
      expect(stack.protocols).toContain(PR_LINKS_HEADER);
      // Untouched invariant (loader.test.ts:164-169): builders never carry memory.
      expect(stack.protocols).not.toContain("# Protocol: Memory");
    } finally {
      if (hadGhToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = hadGhToken;
      if (hadGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = hadGithubToken;
    }
  });

  // AC#4 — fragment reaches the composed prompt, positioned last (after agentBase).
  it("reaches the composed prompt and sits after the identity block (protocols are last)", () => {
    const composed = composeSystemPrompt(readPromptStack("orchestrator", []), {
      agentName: "friday",
      agentType: "orchestrator",
    });
    expect(composed).toContain(PR_LINKS_HEADER);
    expect(composed.indexOf(PR_LINKS_HEADER)).toBeGreaterThan(composed.indexOf("# Identity"));
  });

  // AC#5 — no duplication when the caller also requests it explicitly.
  it("does not duplicate the pr-links protocol when caller passes it explicitly", () => {
    const stack = readPromptStack("orchestrator", ["pr-links"]);
    const occurrences = stack.protocols.split(PR_LINKS_HEADER).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("renderLocalDatetime (FRI-52)", () => {
  beforeEach(() => {
    // Pin to a known instant: 2026-05-23 21:45:00 UTC
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-23T21:45:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a section headed # currentDateTime", () => {
    const block = renderLocalDatetime();
    expect(block).toMatch(/^# currentDateTime\n/);
  });

  it("contains the label 'Current local date and time:'", () => {
    expect(renderLocalDatetime()).toContain("Current local date and time:");
  });

  it("includes a UTC offset in the form UTC±N", () => {
    expect(renderLocalDatetime()).toMatch(/\(UTC[+-]\d/);
  });

  it("includes an AM or PM marker", () => {
    expect(renderLocalDatetime()).toMatch(/[AP]M/);
  });

  it("includes a timezone abbreviation before the offset", () => {
    // Matches abbreviations like PDT, EST, UTC, IST, etc.
    expect(renderLocalDatetime()).toMatch(/[AP]M [A-Z]{2,5} \(UTC/);
  });
});

describe("composeSystemPrompt datetime injection (FRI-52)", () => {
  it("does NOT include currentDateTime — injected per-turn in worker.ts runQuery, not at compose time", () => {
    const stack = readPromptStack("orchestrator", []);
    const composed = composeSystemPrompt(stack, {
      agentName: "friday",
      agentType: "orchestrator",
    });
    expect(composed).not.toContain("# currentDateTime");
    expect(composed).not.toContain("Current local date and time:");
  });

  it("pinned-facts still appears after identity when datetime is absent", () => {
    const stack = readPromptStack("orchestrator", []);
    const pinnedFacts = "# Pinned facts\n\n- **x**: y";
    const composed = composeSystemPrompt(
      stack,
      { agentName: "friday", agentType: "orchestrator" },
      pinnedFacts,
    );
    const idxIdentity = composed.indexOf("# Identity");
    const idxPinned = composed.indexOf("# Pinned facts");
    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxPinned).toBeGreaterThan(idxIdentity);
    expect(composed).not.toContain("# currentDateTime");
  });
});

describe("env-gated protocols (FRI-86)", () => {
  const originalKey = process.env.LINEAR_API_KEY;
  afterEach(() => {
    if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = originalKey;
  });

  it("orchestrator stack auto-includes the linear protocol when LINEAR_API_KEY is set", () => {
    process.env.LINEAR_API_KEY = "test-key";
    const stack = readPromptStack("orchestrator", []);
    expect(stack.protocols).toContain("# Protocol: Linear");
    expect(stack.protocols).toContain("Closes FRI-N");
  });

  it("builder stack auto-includes the linear protocol when LINEAR_API_KEY is set", () => {
    process.env.LINEAR_API_KEY = "test-key";
    const stack = readPromptStack("builder", []);
    expect(stack.protocols).toContain("# Protocol: Linear");
  });

  it("omits the linear protocol when LINEAR_API_KEY is unset", () => {
    delete process.env.LINEAR_API_KEY;
    const stack = readPromptStack("orchestrator", []);
    expect(stack.protocols).not.toContain("# Protocol: Linear");
  });

  it("does not duplicate the linear protocol when caller passes it explicitly", () => {
    process.env.LINEAR_API_KEY = "test-key";
    const stack = readPromptStack("orchestrator", ["linear"]);
    const occurrences = stack.protocols.split("# Protocol: Linear").length - 1;
    expect(occurrences).toBe(1);
  });
});
