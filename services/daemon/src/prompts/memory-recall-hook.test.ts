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

  it("memoryRecallHook surfaces the <memory-context> block via prependBody when memory has hits", async () => {
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
      prependBody: "<memory-context>\nrelevant fact\n</memory-context>",
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

  it("FRI-156 §B: a USER-TYPED /compact (intentTag='user_chat') also skips recall — the real offending path", async () => {
    vi.resetModules();
    // A user typing `/compact` arrives as user_chat (not the `compact` kind —
    // dispatch-listener/resume-listener never construct it), so the body
    // prefix is what must short-circuit recall. Mocks return hits to catch a
    // regression that lets the literal "/compact …" reach recall.
    const buildAutoRecallBlock = vi.fn(
      async () => "<memory-context>\nleaked fact\n</memory-context>",
    );
    const listEntries = vi.fn(() => Promise.resolve([]));
    vi.doMock("@friday/memory", () => ({ buildAutoRecallBlock, listEntries }));
    const { memoryRecallHook } = await import("./memory-recall-hook.js");

    const result = await memoryRecallHook({
      intent: "/compact preserve my persona and open commitments",
      intentTag: "user_chat",
      body: "/compact preserve my persona and open commitments",
      agentType: "orchestrator",
    });

    expect(result).toBeUndefined();
    expect(listEntries).not.toHaveBeenCalled();
    expect(buildAutoRecallBlock).not.toHaveBeenCalled();
  });

  it("a normal user_chat that merely MENTIONS the word compaction still recalls (no over-match)", async () => {
    vi.resetModules();
    const buildAutoRecallBlock = vi.fn(
      async () => "<memory-context>\nrelevant fact\n</memory-context>",
    );
    const listEntries = vi.fn(() => Promise.resolve([]));
    vi.doMock("@friday/memory", () => ({ buildAutoRecallBlock, listEntries }));
    const { memoryRecallHook } = await import("./memory-recall-hook.js");

    const result = await memoryRecallHook({
      intent: "how does compaction work?",
      intentTag: "user_chat",
      body: "how does compaction work?",
      agentType: "orchestrator",
    });

    // NOT a /compact command → recall fires normally.
    expect(result).toEqual({
      prependBody: "<memory-context>\nrelevant fact\n</memory-context>",
    });
    expect(buildAutoRecallBlock).toHaveBeenCalled();
  });
});

describe("recall re-fires per turn off fresh ctx.intent (FRI-24 AC12)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("builds the recall query from the CURRENT turn's intent on each call — turn 2 is not the turn-1 query", async () => {
    vi.resetModules();
    // Listener ready so recall proceeds both turns.
    vi.doMock("../memory/listener.js", () => ({
      whenMemoryListenerReady: () => Promise.resolve(),
    }));
    // The boundary: capture the query text passed to buildAutoRecallBlock on
    // each call and echo it back inside the block so the per-turn freshness is
    // observable in BOTH the call arg AND the returned appendSystemPrompt.
    const buildAutoRecallBlock = vi.fn(
      async (text: string) => `<memory-context>\nquery=${text}\n</memory-context>`,
    );
    const listEntries = vi.fn(() => Promise.resolve([]));
    vi.doMock("@friday/memory", () => ({ buildAutoRecallBlock, listEntries }));
    const { memoryRecallHook } = await import("./memory-recall-hook.js");

    const turn1 = "what did Asher say about the move";
    const turn2 = "summarize the daemon boot sequence";

    const r1 = await memoryRecallHook({
      intent: turn1,
      intentTag: "user_chat",
      body: turn1,
      agentType: "orchestrator",
    });
    const r2 = await memoryRecallHook({
      intent: turn2,
      intentTag: "user_chat",
      body: turn2,
      agentType: "orchestrator",
    });

    // The query text differs turn-to-turn: each call recomputes recall from the
    // CURRENT ctx.intent. A frozen-on-resume regression (turn-1 query reused for
    // turn 2) would make these equal.
    expect(buildAutoRecallBlock).toHaveBeenCalledTimes(2);
    expect(buildAutoRecallBlock.mock.calls[0][0]).toBe(turn1);
    expect(buildAutoRecallBlock.mock.calls[1][0]).toBe(turn2);
    expect(buildAutoRecallBlock.mock.calls[1][0]).not.toBe(buildAutoRecallBlock.mock.calls[0][0]);

    // The block surfaced to the dispatch site carries the CURRENT turn's query
    // and differs turn-to-turn. AC12 is about FRESHNESS, not the delivery
    // channel — the hook may surface the block via `appendSystemPrompt` or
    // `prependBody` (FRI-89: ride the body once the system prompt is frozen on
    // resume), and that choice is FRI-89's concern, asserted elsewhere. Assert
    // channel-agnostically on the block CONTENT so this stays deterministic.
    const blockOf = (r: typeof r1): string | undefined =>
      (r as { appendSystemPrompt?: string; prependBody?: string } | undefined)
        ?.appendSystemPrompt ??
      (r as { appendSystemPrompt?: string; prependBody?: string } | undefined)?.prependBody;
    expect(blockOf(r1)).toBe(`<memory-context>\nquery=${turn1}\n</memory-context>`);
    expect(blockOf(r2)).toBe(`<memory-context>\nquery=${turn2}\n</memory-context>`);
    expect(blockOf(r2)).not.toBe(blockOf(r1));

    // A fresh full-table read happens each turn (recall is not memoized across
    // turns) — both turns drove listEntries().
    expect(listEntries).toHaveBeenCalledTimes(2);
  });
});

describe("before_prompt_build hook composition surface (FRI-123)", () => {
  // Rewritten per the FRI-123 ticket's BLOCKED-ON-OWNER default
  // (Option A): assert the `runHooks` composition surface directly
  // — the entry point that USES this composition lives in
  // `prompts/build-dispatch-prompt.ts` and its golden tests cover
  // the end-to-end stitching.

  it("runHooks returns the prependBody payload that the recall handler produces", async () => {
    registerHook("before_prompt_build", async () => ({
      prependBody: "<memory-context>\nrelevant fact\n</memory-context>",
    }));

    const results = await runHooks("before_prompt_build", {
      intent: "user query",
      intentTag: "user_chat",
      body: "actual user body",
      agentType: "orchestrator",
    });

    expect(results).toEqual([
      { prependBody: "<memory-context>\nrelevant fact\n</memory-context>" },
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
