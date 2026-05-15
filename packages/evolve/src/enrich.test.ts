import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Proposal } from "./types.js";
import { ChatAbortError } from "./llm.js";

const proposals = new Map<string, Proposal>();

vi.mock("./store.js", () => ({
  getProposal: (id: string) => proposals.get(id) ?? null,
  listProposals: () => [...proposals.values()],
  updateProposal: (id: string, updates: Partial<Proposal>) => {
    const existing = proposals.get(id);
    if (!existing) return null;
    const next = {
      ...existing,
      ...updates,
      updatedAt: updates.updatedAt ?? new Date().toISOString(),
    } as Proposal;
    proposals.set(id, next);
    return next;
  },
}));

const { enrichProposals } = await import("./enrich.js");

function makeProposal(id: string): Proposal {
  return {
    id,
    title: "daemon fatal repeating",
    type: "memory",
    status: "critical",
    clusterId: null,
    score: 63,
    signals: [
      {
        hash: "abcd1234",
        source: "daemon",
        key: "daemon.fatal",
        severity: "high",
        count: 5,
        firstSeenAt: "2026-05-13T00:00:00.000Z",
        lastSeenAt: "2026-05-15T00:00:00.000Z",
        evidencePointers: [],
      },
    ],
    proposedChange: "templated body",
    blastRadius: "low",
    appliesTo: [],
    createdBy: "test",
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    appliedAt: null,
    appliedBy: null,
    enrichedAt: null,
    enrichedBy: null,
    lastEnrichError: null,
    lastEnrichFailedAt: null,
    appliedTicketId: null,
  };
}

beforeEach(() => {
  proposals.clear();
});

describe("enrichProposals retry-on-timeout", () => {
  it("retries once when the first attempt times out and succeeds on the second", async () => {
    const p = makeProposal("daemon-fatal-repeating-fzmp");
    proposals.set(p.id, p);

    const attempts: number[] = [];
    const enrichFn = vi.fn(async () => {
      attempts.push(Date.now());
      if (attempts.length === 1) {
        throw new ChatAbortError("timeout", "enrichment timed out after 180s");
      }
      return {
        body: "## Signal summary\nDaemon kept crashing.\n## Root cause\nFoo.\n## Suggested change\nBar.",
        type: "code" as const,
        blastRadius: "medium" as const,
      };
    });

    const result = await enrichProposals({ id: p.id, enrichFn });

    expect(enrichFn).toHaveBeenCalledTimes(2);
    expect(result.failed).toEqual([]);
    expect(result.enriched).toHaveLength(1);
    expect(result.enriched[0].proposedChange).toContain("Daemon kept crashing");
    expect(result.enriched[0].type).toBe("code");
    expect(result.enriched[0].blastRadius).toBe("medium");
    expect(result.enriched[0].lastEnrichError).toBeNull();
  });

  it("does not retry on non-timeout aborts (e.g. interrupted)", async () => {
    const p = makeProposal("interrupted-1");
    proposals.set(p.id, p);

    const enrichFn = vi.fn(async () => {
      throw new ChatAbortError("interrupted", "aborted by parent");
    });

    const result = await enrichProposals({ id: p.id, enrichFn });

    expect(enrichFn).toHaveBeenCalledTimes(1);
    expect(result.enriched).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].abortReason).toBe("interrupted");
    const stored = proposals.get(p.id)!;
    expect(stored.lastEnrichError).toContain("aborted");
    expect(stored.lastEnrichFailedAt).not.toBeNull();
  });

  it("surfaces a persistent timeout after the retry also fails", async () => {
    const p = makeProposal("timeout-twice-1");
    proposals.set(p.id, p);

    const enrichFn = vi.fn(async () => {
      throw new ChatAbortError("timeout", "enrichment timed out after 300s");
    });

    const result = await enrichProposals({ id: p.id, enrichFn });

    expect(enrichFn).toHaveBeenCalledTimes(2);
    expect(result.enriched).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].abortReason).toBe("timeout");
    expect(proposals.get(p.id)!.lastEnrichError).toContain("timed out");
  });
});
