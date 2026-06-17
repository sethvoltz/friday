/**
 * FRI-89: integration tests proving dynamic memory recall now rides the
 * per-turn BODY (`prependBody`), not the frozen `systemPrompt.append`.
 *
 * Unlike the golden suite in `build-dispatch-prompt.test.ts` (real
 * Postgres, no hooks registered), this file fully mocks `@friday/memory`
 * and the memory listener, then registers the REAL `memoryRecallHook` and
 * drives `buildDispatchPrompt` end-to-end. That lets us assert exactly
 * which channel carries the recall block without standing up a DB.
 *
 * Module-epoch discipline: `@friday/memory`/listener are mocked with
 * `vi.doMock`, so `buildDispatchPrompt`, `memoryRecallHook`, AND the hook
 * registry (`@friday/shared`) are all dynamically imported AFTER the mocks
 * inside a single `vi.resetModules()` epoch — otherwise `registerHook`
 * would write into a different registry instance than the one
 * `buildDispatchPrompt` reads, and the hook would silently never fire.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

type RecallMock = () => Promise<string>;

interface PinSeed {
  title: string;
  content: string;
}

/**
 * Mock `@friday/memory` + the listener, register the real recall hook
 * into the SAME module epoch as `buildDispatchPrompt`, and return the
 * epoch-bound `buildDispatchPrompt`. `recall` is the `buildAutoRecallBlock`
 * implementation; `pins` (optional) drives `listPinnedForAgent`.
 */
async function wireRecall(recall: RecallMock, pins: PinSeed[] = []) {
  vi.doMock("@friday/memory", () => ({
    buildAutoRecallBlock: recall,
    listEntries: () => Promise.resolve([]),
    listPinnedForAgent: () =>
      Promise.resolve(
        pins.map((p, i) => ({
          id: `pin-${i}`,
          title: p.title,
          content: p.content,
          tags: ["pinned"],
          createdBy: "tester",
          createdAt: "2026-06-17T00:00:00Z",
          updatedAt: "2026-06-17T00:00:00Z",
          recallCount: 0,
          lastRecalledAt: null,
        })),
      ),
  }));
  vi.doMock("../memory/listener.js", () => ({
    whenMemoryListenerReady: () => Promise.resolve(),
  }));

  const shared = await import("@friday/shared");
  const { memoryRecallHook } = await import("./memory-recall-hook.js");
  const { buildDispatchPrompt } = await import("./build-dispatch-prompt.js");

  shared.__resetHooksForTest();
  shared.registerHook("before_prompt_build", memoryRecallHook);
  return buildDispatchPrompt;
}

describe("FRI-89: dynamic recall rides the body, not the systemPrompt", () => {
  it("dynamic recall appears in the BODY and NOT the systemPrompt (end-to-end through buildDispatchPrompt)", async () => {
    const buildDispatchPrompt = await wireRecall(
      async () => "<memory-context>\nFRESH\n</memory-context>",
    );

    const out = await buildDispatchPrompt(
      { name: "orch", type: "orchestrator" },
      { kind: "user_chat", userText: "hello" },
    );

    expect(out.body).toBe("<memory-context>\nFRESH\n</memory-context>\n\nhello");
    // The static prompt-stack copy legitimately mentions the literal
    // "<memory-context>" tag, so the negative assertion must pin the
    // dynamic CONTENT ("FRESH"), never the bare tag.
    expect(out.systemPrompt).not.toContain("<memory-context>\nFRESH");
  });

  it("resumed turn body carries freshly recalled memory, not the session-start block", async () => {
    // Two dispatches with DIFFERENT recall results. Because recall now rides
    // the body (a fresh user message every turn) the second/resumed turn
    // carries the recomputed block — the exact frozen-on-resume bug, pinned
    // at the layer it lives in (SDK-resume freeze is upstream-proven by FRI-167).
    const recall = vi
      .fn<RecallMock>()
      .mockResolvedValueOnce("<memory-context>\nOLD\n</memory-context>")
      .mockResolvedValueOnce("<memory-context>\nNEW\n</memory-context>");
    const buildDispatchPrompt = await wireRecall(recall);

    const first = await buildDispatchPrompt(
      { name: "orch", type: "orchestrator" },
      { kind: "user_chat", userText: "first turn" },
    );
    const second = await buildDispatchPrompt(
      { name: "orch", type: "orchestrator" },
      { kind: "user_chat", userText: "second turn" },
    );

    expect(first.body).toContain("OLD");
    expect(second.body).toContain("NEW");
    expect(second.body).not.toContain("OLD");
  });

  it("pinned facts STILL render in the systemPrompt, not the body, alongside body-recall", async () => {
    const buildDispatchPrompt = await wireRecall(
      async () => "<memory-context>\nrecalled\n</memory-context>",
      [{ title: "test pin", content: "test value" }],
    );

    const out = await buildDispatchPrompt(
      { name: "orch", type: "orchestrator" },
      { kind: "user_chat", userText: "hello" },
    );

    // Pinned facts stay in the system channel (stable per agent by design)...
    expect(out.systemPrompt).toContain("# Pinned facts");
    expect(out.systemPrompt).toContain("- **test pin**: test value");
    // ...and do NOT leak into the body alongside the dynamic recall block.
    expect(out.body).not.toContain("# Pinned facts");
    // Recall itself rode the body, confirming both channels coexist.
    expect(out.body).toContain("<memory-context>\nrecalled\n</memory-context>");
  });
});
