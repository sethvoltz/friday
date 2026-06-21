import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyDreamProposals, type DreamApplyDeps } from "./dreaming-pipeline.js";
import { encodeDreamPayload, type DreamPayload } from "./scan-dreaming.js";
import { slugify } from "./apply.js";
import type { Proposal, Signal } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────
// Fixtures — a dream-shaped proposal whose single signal carries a decodable
// DreamPayload (mirrors what bucketByCandidate → draftFromSignal produce).
// ─────────────────────────────────────────────────────────────────────────

function dreamSignal(payload: DreamPayload): Signal {
  const slug = slugify(payload.title);
  return {
    hash: `hash-${slug}`,
    source: "dream",
    key: `dream:promote:${slug}`,
    severity: "medium",
    count: 1,
    firstSeenAt: "2026-05-01T00:00:00.000Z",
    lastSeenAt: "2026-05-01T00:00:00.000Z",
    agent: "orchestrator",
    evidencePointers: [encodeDreamPayload(payload)],
  };
}

function dreamProposal(
  payload: DreamPayload,
  score: number,
  overrides: Partial<Proposal> = {},
): Proposal {
  const slug = slugify(payload.title);
  const now = "2026-05-01T00:00:00.000Z";
  return {
    id: `p-${slug}`,
    title: payload.title,
    type: "memory",
    status: "open",
    clusterId: null,
    score,
    signals: [dreamSignal(payload)],
    proposedChange: payload.content,
    blastRadius: "low",
    appliesTo: ["memory:dreaming", payload.category, ...payload.tags],
    createdBy: "scheduled-meta-daily",
    createdAt: now,
    updatedAt: now,
    appliedAt: null,
    appliedBy: null,
    enrichedAt: null,
    enrichedBy: null,
    lastEnrichError: null,
    lastEnrichFailedAt: null,
    appliedTicketId: null,
    familyResolvedBy: null,
    builderAgent: null,
    resolvedByUpgrade: false,
    tentativelyResolvedByUpgrade: false,
    resolvedByVersion: null,
    resolvedAt: null,
    ...overrides,
  };
}

/**
 * Build an injectable `deps` whose IO boundary is spies. By default
 * `searchMemories` returns no dedup hit; pass `searchHits` to simulate one.
 */
function makeDeps(
  searchHits: Array<{ id: string; tags: string[]; content: string; score: number }> = [],
): DreamApplyDeps {
  return {
    searchMemories: vi.fn(async () =>
      searchHits.map((h) => ({
        entry: {
          id: h.id,
          title: h.id,
          content: h.content,
          tags: h.tags,
          createdBy: "test",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          recallCount: 0,
          lastRecalledAt: null,
        },
        score: h.score,
        matchedOn: [],
      })),
    ),
    updateEntry: vi.fn(async () => {}),
    applyProposal: vi.fn(async (id: string) => ({
      ok: true as const,
      proposal: { id } as Proposal,
      appliedRef: `memory:${id}`,
    })),
    updateProposal: vi.fn(() => null),
  };
}

describe("applyDreamProposals", () => {
  it("auto-applies a proposal that clears its category threshold (AC3)", async () => {
    // feedback threshold is 60; score 70 clears it. No dedup hit.
    const proposal = dreamProposal(
      {
        title: "Always deploy via friday update",
        content: "...",
        tags: ["deploy"],
        category: "feedback",
      },
      70,
    );
    const deps = makeDeps();

    const result = await applyDreamProposals([proposal], "scheduled-meta-daily", deps);

    expect(deps.applyProposal).toHaveBeenCalledTimes(1);
    expect(deps.applyProposal).toHaveBeenCalledWith(proposal.id, {
      appliedBy: "scheduled-meta-daily",
    });
    expect(deps.updateEntry).not.toHaveBeenCalled();
    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0].action).toBe("promoted");
    expect(result.promoted[0].title).toBe(proposal.title);
    expect(result.reinforced).toHaveLength(0);
    expect(result.openBelowThreshold).toHaveLength(0);
  });

  it("extends an existing memory on a dedup hit instead of applying (AC4)", async () => {
    const proposal = dreamProposal(
      {
        title: "Seth works in Pacific time",
        content: "new detail",
        tags: ["timezone"],
        category: "user",
      },
      90, // would clear the user:55 bar, but the dedup hit short-circuits.
    );
    // searchMemories returns a hit clearing DREAM_DEDUP_MIN_SCORE (5).
    const deps = makeDeps([
      { id: "seth-works-in-pacific-time", tags: ["evolve", "user"], content: "old body", score: 8 },
    ]);

    const result = await applyDreamProposals([proposal], "scheduled-meta-daily", deps);

    expect(deps.updateEntry).toHaveBeenCalledTimes(1);
    const [id, patch] = (deps.updateEntry as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(id).toBe("seth-works-in-pacific-time");
    // Folds the new content in and unions the proposed tags — and must NOT
    // touch recallCount/lastRecalledAt (preserve survivor recall metadata).
    expect(patch.content).toContain("old body");
    expect(patch.content).toContain("new detail");
    expect(patch.tags).toContain("memory:dreaming");
    expect(patch.tags).toContain("timezone");
    expect(patch).not.toHaveProperty("recallCount");
    expect(patch).not.toHaveProperty("lastRecalledAt");

    expect(deps.applyProposal).not.toHaveBeenCalled();
    expect(result.reinforced).toHaveLength(1);
    expect(result.reinforced[0].action).toBe("reinforced");
    // F13/F18: the diary note renders the REAL search score (8), not the
    // hardcoded DREAM_DEDUP_MIN_SCORE floor.
    expect(result.reinforced[0].evidence).toContain("search score 8");
    expect(result.reinforced[0].evidence).not.toContain("score 5");
    expect(result.promoted).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it("leaves a person proposal scoring < 80 open (AC7a)", async () => {
    // person threshold is 80; score 75 is below → stays open, writes nothing.
    const proposal = dreamProposal(
      {
        title: "Dana Chen — Linear admin",
        content: "Dana administers the Linear workspace.",
        tags: ["person", "person:dana-chen"],
        category: "person",
      },
      75,
    );
    const deps = makeDeps();

    const result = await applyDreamProposals([proposal], "scheduled-meta-daily", deps);

    expect(deps.applyProposal).not.toHaveBeenCalled();
    expect(deps.updateEntry).not.toHaveBeenCalled();
    expect(result.openBelowThreshold).toEqual([proposal.id]);
    expect(result.promoted).toHaveLength(0);
    expect(result.reinforced).toHaveLength(0);
  });

  it("auto-applies a person proposal scoring >= 80 (AC7b)", async () => {
    const proposal = dreamProposal(
      {
        title: "Dana Chen — Linear admin",
        content: "Dana administers the Linear workspace.",
        tags: ["person", "person:dana-chen"],
        category: "person",
      },
      85,
    );
    const deps = makeDeps();

    const result = await applyDreamProposals([proposal], "scheduled-meta-daily", deps);

    expect(deps.applyProposal).toHaveBeenCalledTimes(1);
    expect(deps.applyProposal).toHaveBeenCalledWith(proposal.id, {
      appliedBy: "scheduled-meta-daily",
    });
    expect(deps.updateEntry).not.toHaveBeenCalled();
    expect(result.promoted).toHaveLength(1);
    expect(result.openBelowThreshold).toHaveLength(0);
  });

  it("records an apply-failure in `failed`, NOT openBelowThreshold (F20)", async () => {
    // Clears the feedback:60 bar with 70, so it reaches applyProposal — but the
    // apply returns ok:false. That is a genuine failure (deferred-for-review is
    // a DIFFERENT state), so it must land in `failed` with nothing in
    // openBelowThreshold and no diary row.
    const proposal = dreamProposal(
      {
        title: "Always deploy via friday update",
        content: "...",
        tags: ["deploy"],
        category: "feedback",
      },
      70,
    );
    const deps = makeDeps();
    deps.applyProposal = vi.fn(async () => ({
      ok: false as const,
      reason: "already applied",
    }));

    const result = await applyDreamProposals([proposal], "scheduled-meta-daily", deps);

    expect(deps.applyProposal).toHaveBeenCalledTimes(1);
    expect(result.failed).toEqual([proposal.id]);
    expect(result.openBelowThreshold).toHaveLength(0);
    expect(result.promoted).toHaveLength(0);
    expect(result.reinforced).toHaveLength(0);
  });

  // AC10: preserve-over-delete guard — this module never references forgetEntry.
  it("never references forgetEntry (AC10)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "dreaming-pipeline.ts"), "utf8");
    expect(source).not.toMatch(/forgetEntry/);
  });
});
