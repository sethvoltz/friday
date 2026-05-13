import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// FIX_FORWARD 2.5: safeRecall is best-effort. wrapWithRecall returns the
// body unchanged when recall is empty; prepends `<memory-context>` when
// memory has hits. We don't seed real memory entries here; instead we
// verify behaviour against an empty store (the most common path on a
// fresh daemon) and verify that a thrown buildAutoRecallBlock is caught
// and the body still flows through.

const dataDir = mkdtempSync(join(tmpdir(), "friday-recall-"));
process.env.FRIDAY_DATA_DIR = dataDir;

beforeAll(async () => {
  const { runMigrations } = await import("@friday/shared");
  runMigrations();
});

afterAll(async () => {
  const { closeDb } = await import("@friday/shared");
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("recall helpers (FIX_FORWARD 2.5)", () => {
  it("wrapWithRecall returns the body verbatim when memory is empty", async () => {
    const { wrapWithRecall } = await import("./recall.js");
    // Distinct intentText vs body so a regression that accidentally
    // emitted the intent into the output (instead of the body) would
    // surface — the previous version passed body for both.
    const out = wrapWithRecall("recall query", "response body", "user_chat");
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
    expect(wrapWithRecall("intent", body, "mail")).toBe(body);
    vi.unmock("@friday/memory");
    vi.resetModules();
  });

  it("wrapWithRecall prepends the block when buildAutoRecallBlock returns content", async () => {
    vi.resetModules();
    vi.doMock("@friday/memory", () => ({
      buildAutoRecallBlock: (_t: string) =>
        "<memory-context>\nrelevant fact\n</memory-context>",
    }));
    const { wrapWithRecall } = await import("./recall.js");
    const body = "actual prompt body";
    const out = wrapWithRecall("intent", body, "scheduled");
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
