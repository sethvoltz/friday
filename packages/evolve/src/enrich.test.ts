import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `friday-evolve-enrich-${process.pid}-${Date.now()}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testDir };
});

import type { Signal } from "./store.js";
import { ChatAbortError } from "./llm.js";

const { enrichProposals, hydrateEvidence } = await import("./enrich.js");
const { saveProposal, getProposal, ensureImprovementsDirs } = await import("./store.js");

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    hash: "h1",
    source: "transcript",
    key: "friction_correction",
    severity: "medium",
    count: 1,
    firstSeenAt: "2026-04-27T12:00:00.000Z",
    lastSeenAt: "2026-04-27T12:00:00.000Z",
    agent: "orchestrator",
    evidencePointers: [],
    ...overrides,
  };
}

describe("enrichProposals", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    ensureImprovementsDirs();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("rewrites the body and stamps enrichedAt/enrichedBy", async () => {
    const p = saveProposal({
      title: "friction correction repeating on orchestrator",
      type: "memory",
      proposedChange: "Awaiting enrichment.",
      signals: [makeSignal()],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "scheduled-meta-daily",
    });

    const enrichFn = vi.fn().mockResolvedValue({
      body: "**Signal summary** ...\n**Root cause** ...\n**Suggested change** edit prompt.",
      type: "prompt" as const,
      blastRadius: "low" as const,
    });

    const result = await enrichProposals({ id: p.id, enrichFn, model: "test-model" });

    expect(result.enriched).toHaveLength(1);
    expect(result.failed).toEqual([]);
    const updated = getProposal(p.id);
    expect(updated?.proposedChange).toContain("Suggested change");
    expect(updated?.type).toBe("prompt");
    expect(updated?.enrichedBy).toBe("test-model");
    expect(updated?.enrichedAt).toBeTruthy();
  });

  it("is idempotent: skips proposals where enrichedAt >= updatedAt", async () => {
    const p = saveProposal({
      title: "x",
      type: "memory",
      proposedChange: "stub",
      signals: [makeSignal()],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "cli",
    });

    const enrichFn = vi.fn().mockResolvedValue({
      body: "body",
      type: "memory" as const,
      blastRadius: "low" as const,
    });

    const first = await enrichProposals({ id: p.id, enrichFn });
    expect(first.enriched).toHaveLength(1);
    expect(enrichFn).toHaveBeenCalledTimes(1);

    const second = await enrichProposals({ id: p.id, enrichFn });
    expect(second.enriched).toEqual([]);
    expect(second.skipped[0].reason).toBe("already enriched");
    expect(enrichFn).toHaveBeenCalledTimes(1);
  });

  it("--force re-enriches even when fresh", async () => {
    const p = saveProposal({
      title: "x",
      type: "memory",
      proposedChange: "stub",
      signals: [makeSignal()],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "cli",
    });

    const enrichFn = vi
      .fn()
      .mockResolvedValueOnce({ body: "first", type: "memory" as const, blastRadius: "low" as const })
      .mockResolvedValueOnce({ body: "second", type: "prompt" as const, blastRadius: "low" as const });

    await enrichProposals({ id: p.id, enrichFn });
    const second = await enrichProposals({ id: p.id, enrichFn, force: true });

    expect(second.enriched).toHaveLength(1);
    expect(enrichFn).toHaveBeenCalledTimes(2);
    expect(getProposal(p.id)?.proposedChange).toBe("second");
    expect(getProposal(p.id)?.type).toBe("prompt");
  });

  it("captures errors per-proposal without aborting the run", async () => {
    const p1 = saveProposal({
      title: "first",
      type: "memory",
      proposedChange: "stub",
      signals: [makeSignal({ hash: "h1" })],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "cli",
    });
    const p2 = saveProposal({
      title: "second",
      type: "memory",
      proposedChange: "stub",
      signals: [makeSignal({ hash: "h2" })],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "cli",
    });

    const enrichFn = vi
      .fn()
      .mockImplementation(async (proposal: { id: string }) => {
        if (proposal.id === p1.id) throw new Error("boom");
        return { body: "ok", type: "memory" as const, blastRadius: "low" as const };
      });

    const result = await enrichProposals({ all: true, enrichFn });
    expect(result.failed.map((f) => f.id)).toContain(p1.id);
    expect(result.enriched.map((e) => e.id)).toContain(p2.id);
  });

  it("records limit-reached skips when more proposals than --limit", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = saveProposal({
        title: `p-${i}`,
        type: "memory",
        proposedChange: "stub",
        signals: [makeSignal({ hash: `h${i}` })],
        blastRadius: "low",
        appliesTo: [],
        createdBy: "cli",
      });
      ids.push(p.id);
    }

    const enrichFn = vi.fn().mockResolvedValue({
      body: "body",
      type: "memory" as const,
      blastRadius: "low" as const,
    });

    const result = await enrichProposals({ all: true, enrichFn, limit: 1 });
    expect(result.enriched).toHaveLength(1);
    expect(result.skipped.some((s) => s.reason === "limit reached")).toBe(true);
  });

  it("persists lastEnrichError on failure and clears it on success", async () => {
    const p = saveProposal({
      title: "error-then-success",
      type: "memory",
      proposedChange: "stub",
      signals: [makeSignal()],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "cli",
    });

    const failFn = vi.fn().mockRejectedValue(new Error("boom"));
    await enrichProposals({ id: p.id, enrichFn: failFn });

    const afterFail = getProposal(p.id);
    expect(afterFail?.lastEnrichError).toBe("boom");
    expect(afterFail?.lastEnrichFailedAt).toBeTruthy();

    const successFn = vi.fn().mockResolvedValue({
      body: "fixed",
      type: "memory" as const,
      blastRadius: "low" as const,
    });
    await enrichProposals({ id: p.id, enrichFn: successFn });

    const afterSuccess = getProposal(p.id);
    expect(afterSuccess?.lastEnrichError).toBeNull();
    expect(afterSuccess?.lastEnrichFailedAt).toBeNull();
    expect(afterSuccess?.proposedChange).toBe("fixed");
  });

  it("surfaces abortReason in failed array when ChatAbortError thrown", async () => {
    const p = saveProposal({
      title: "abort-test",
      type: "memory",
      proposedChange: "stub",
      signals: [makeSignal()],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "cli",
    });

    const abortFn = vi.fn().mockRejectedValue(
      new ChatAbortError("interrupted", "enrichment aborted (SIGINT or parent session lifecycle)")
    );
    const result = await enrichProposals({ id: p.id, enrichFn: abortFn });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].abortReason).toBe("interrupted");
    expect(result.failed[0].error).toContain("aborted");
    expect(getProposal(p.id)?.lastEnrichError).toContain("aborted");
  });

  it("--retry-failed targets only proposals with lastEnrichError set", async () => {
    const failed = saveProposal({
      title: "failed-proposal",
      type: "memory",
      proposedChange: "stub",
      signals: [makeSignal({ hash: "h-fail" })],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "cli",
    });
    const clean = saveProposal({
      title: "clean-proposal",
      type: "memory",
      proposedChange: "stub",
      signals: [makeSignal({ hash: "h-clean" })],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "cli",
    });

    // Simulate a previous failure on 'failed'.
    const failFn = vi.fn().mockRejectedValue(new Error("abort"));
    await enrichProposals({ id: failed.id, enrichFn: failFn });

    const successFn = vi.fn().mockResolvedValue({
      body: "retried",
      type: "memory" as const,
      blastRadius: "low" as const,
    });
    const result = await enrichProposals({ retryFailed: true, enrichFn: successFn });

    expect(result.enriched.map((e) => e.id)).toContain(failed.id);
    expect(result.enriched.map((e) => e.id)).not.toContain(clean.id);
    expect(successFn).toHaveBeenCalledTimes(1);
  });
});

describe("hydrateEvidence", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = join(testDir, "ev");
    mkdirSync(workDir, { recursive: true });
  });

  it("reads ±2 lines around the pointer", () => {
    const path = join(workDir, "sample.txt");
    writeFileSync(path, "line1\nline2\nline3\nline4\nline5\nline6\n");

    const out = hydrateEvidence(
      [
        makeSignal({
          evidencePointers: [{ kind: "transcript", path, line: 4 }],
        }),
      ],
      2000
    );
    expect(out).toHaveLength(1);
    expect(out[0].snippet).toBe("line2\nline3\nline4\nline5\nline6");
  });

  it("returns empty snippet when path is missing", () => {
    const out = hydrateEvidence(
      [
        makeSignal({
          evidencePointers: [{ kind: "transcript", path: join(workDir, "absent") }],
        }),
      ],
      2000
    );
    expect(out[0].snippet).toBe("");
  });

  it("respects the char cap", () => {
    const path = join(workDir, "big.txt");
    writeFileSync(path, "a".repeat(5000));

    const out = hydrateEvidence(
      [
        makeSignal({
          evidencePointers: [{ kind: "transcript", path }],
        }),
      ],
      100
    );
    expect(out[0].snippet.length).toBe(100);
  });
});
