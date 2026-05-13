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
    const body = "hello world";
    const out = wrapWithRecall(body, body, "user_chat");
    expect(out).toBe(body);
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
    expect(out.startsWith("<memory-context>")).toBe(true);
    expect(out.endsWith(body)).toBe(true);
    vi.unmock("@friday/memory");
    vi.resetModules();
  });
});
