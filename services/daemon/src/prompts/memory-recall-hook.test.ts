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
      listEntries: () => Promise.resolve([]),
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
      listEntries: () => Promise.resolve([]),
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
      listEntries: () => Promise.resolve([]),
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

  it("FRI-156 §B: returns void for intentTag='compact' WITHOUT touching memory (no recall pollution)", async () => {
    vi.resetModules();
    // Both memory fns would otherwise produce a non-empty recall block — the
    // mock returns hits so a regression that DROPS the compact early-return
    // would surface as a non-undefined result. They must NOT be called at all.
    const buildAutoRecallBlock = vi.fn(
      async () => "<memory-context>\nleaked fact\n</memory-context>",
    );
    const listEntries = vi.fn(() => Promise.resolve([]));
    vi.doMock("@friday/memory", () => ({ buildAutoRecallBlock, listEntries }));
    const { memoryRecallHook } = await import("./memory-recall-hook.js");

    const result = await memoryRecallHook({
      // The literal "/compact …" body would be a garbage FTS query — the whole
      // point of the early-return is that it never reaches recall.
      intent: "",
      intentTag: "compact",
      body: "/compact <persona instructions>",
      agentType: "orchestrator",
    });

    expect(result).toBeUndefined();
    // No listEntries() read (recallCount pollution + full-table scan avoided)
    // and no recall block built.
    expect(listEntries).not.toHaveBeenCalled();
    expect(buildAutoRecallBlock).not.toHaveBeenCalled();
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
    vi.doMock("@friday/memory", () => ({
      buildAutoRecallBlock: buildMock,
      listEntries: () => Promise.resolve([]),
    }));
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
      listEntries: () => Promise.resolve([]),
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
      listEntries: () => Promise.resolve([]),
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

describe("person name-mention carve-out wiring (FRI-141, AC#8)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  function mockMemoryWithPersons() {
    const buildSpy = vi.fn().mockResolvedValue("");
    vi.doMock("../memory/listener.js", () => ({
      whenMemoryListenerReady: () => Promise.resolve(),
    }));
    vi.doMock("@friday/memory", () => ({
      buildAutoRecallBlock: buildSpy,
      listEntries: () =>
        Promise.resolve([
          {
            id: "person-asher",
            title: "Asher notes",
            content: "asher facts",
            tags: ["person", "person:asher"],
            createdBy: "tester",
            createdAt: "2026-05-15T00:00:00Z",
            updatedAt: "2026-05-15T00:00:00Z",
            recallCount: 0,
            lastRecalledAt: null,
          },
          {
            id: "person-mike",
            title: "Mike notes",
            content: "mike facts",
            tags: ["person", "person:mike"],
            createdBy: "tester",
            createdAt: "2026-05-15T00:00:00Z",
            updatedAt: "2026-05-15T00:00:00Z",
            recallCount: 0,
            lastRecalledAt: null,
          },
        ]),
    }));
    return buildSpy;
  }

  it("forwards allowTags:['person:asher'] when the turn names Asher", async () => {
    const buildSpy = mockMemoryWithPersons();
    const { memoryRecallHook } = await import("./memory-recall-hook.js");

    await memoryRecallHook({
      intent: "did Asher say anything about the move",
      intentTag: "user_chat",
      body: "did Asher say anything about the move",
      agentType: "orchestrator",
    });

    expect(buildSpy).toHaveBeenCalledWith(
      "did Asher say anything about the move",
      expect.objectContaining({ excludeTags: ["person"], allowTags: ["person:asher"] }),
    );
  });

  it("forwards an empty allowTags when the turn names no known person", async () => {
    const buildSpy = mockMemoryWithPersons();
    const { memoryRecallHook } = await import("./memory-recall-hook.js");

    await memoryRecallHook({
      intent: "fix the daemon worker fork race",
      intentTag: "user_chat",
      body: "fix the daemon worker fork race",
      agentType: "orchestrator",
    });

    expect(buildSpy).toHaveBeenCalledWith(
      "fix the daemon worker fork race",
      expect.objectContaining({ excludeTags: ["person"], allowTags: [] }),
    );
  });
});

describe("computePersonAllowTags (FRI-141 pure helper)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  function mkPerson(id: string, tags: string[]) {
    return {
      id,
      title: id,
      content: "",
      tags,
      createdBy: "tester",
      createdAt: "2026-05-15T00:00:00Z",
      updatedAt: "2026-05-15T00:00:00Z",
      recallCount: 0,
      lastRecalledAt: null,
    };
  }

  it("matches a name token case-insensitively against a dash-separated segment", async () => {
    const { computePersonAllowTags } = await import("./memory-recall-hook.js");
    const entries = [
      mkPerson("a", ["person", "person:mike-coworker"]),
      mkPerson("b", ["person", "person:asher"]),
    ];
    // "Mike" (capitalised) matches the first segment of person:mike-coworker.
    expect(computePersonAllowTags("did Mike review the PR", entries)).toEqual([
      "person:mike-coworker",
    ]);
  });

  it("returns [] when no name token matches (no substring / fuzzy match)", async () => {
    const { computePersonAllowTags } = await import("./memory-recall-hook.js");
    const entries = [mkPerson("b", ["person", "person:asher"])];
    // "ash" is a substring of "asher" but NOT an exact token — must not match.
    expect(computePersonAllowTags("turn the ash into mulch", entries)).toEqual([]);
  });

  it("ignores person:<name> tags on entries lacking the bare 'person' type tag", async () => {
    const { computePersonAllowTags } = await import("./memory-recall-hook.js");
    const entries = [mkPerson("c", ["person:asher"])]; // no "person" tag
    expect(computePersonAllowTags("did Asher call", entries)).toEqual([]);
  });

  it("re-admits on a non-name descriptor segment — all-segment match is intentional (FRI-141 owner decision)", async () => {
    const { computePersonAllowTags } = await import("./memory-recall-hook.js");
    const entries = [mkPerson("m", ["person", "person:mike-coworker"])];
    // The carve-out matches ANY dash-separated segment, so a generic descriptor
    // token ("coworker") re-admits the person even when no name appears in the
    // turn. This is the documented, deliberate behaviour (see the `person`
    // section of protocols/memory.md) — pinned here so it stays a decision, not
    // an accident. Choosing a distinctive `person:<name>` segment narrows recall.
    expect(computePersonAllowTags("my coworker pushed a fix", entries)).toEqual([
      "person:mike-coworker",
    ]);
  });
});
