import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

// FIX_FORWARD 2.5: safeRecall is best-effort. wrapWithRecall returns the
// body unchanged when recall is empty; prepends `<memory-context>` when
// memory has hits. We don't seed real memory entries here; instead we
// verify behaviour against an empty store (the most common path on a
// fresh daemon) and verify that a thrown buildAutoRecallBlock is caught
// and the body still flows through.

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "recall" });
});

afterAll(async () => {
  await handle.drop();
});

describe("recall helpers (FIX_FORWARD 2.5)", () => {
  it("wrapWithRecall returns the body verbatim when memory is empty", async () => {
    const { wrapWithRecall } = await import("./recall.js");
    // Distinct intentText vs body so a regression that accidentally
    // emitted the intent into the output (instead of the body) would
    // surface — the previous version passed body for both.
    const out = await wrapWithRecall(
      "recall query",
      "response body",
      "user_chat",
    );
    expect(out).toBe("response body");
  });

  it("wrapWithRecall preserves the body when buildAutoRecallBlock throws", async () => {
    vi.resetModules();
    vi.doMock("@friday/memory", () => ({
      buildAutoRecallBlock: () => {
        throw new Error("memory backend down");
      },
    }));
    const { wrapWithRecall } = await import("./recall.js");
    const body = "fallback path body";
    expect(await wrapWithRecall("intent", body, "mail")).toBe(body);
    vi.unmock("@friday/memory");
    vi.resetModules();
  });

  it("wrapWithRecall prepends the block when buildAutoRecallBlock returns content", async () => {
    vi.resetModules();
    vi.doMock("@friday/memory", () => ({
      buildAutoRecallBlock: async (_t: string) =>
        "<memory-context>\nrelevant fact\n</memory-context>",
    }));
    const { wrapWithRecall } = await import("./recall.js");
    const body = "actual prompt body";
    const out = await wrapWithRecall("intent", body, "scheduled");
    // Pin the exact join — `\n\n` between the block and the body is the
    // documented contract. `startsWith` + `endsWith` would let a regression
    // that fused the two (`...</memory-context>actual prompt body`) pass.
    expect(out).toBe(
      "<memory-context>\nrelevant fact\n</memory-context>\n\n" + body,
    );
    vi.unmock("@friday/memory");
    vi.resetModules();
  });
});
