import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Proposal, Signal } from "./types.js";

const proposals = new Map<string, Proposal>();
const bySignalHash = new Map<string, string>();

vi.mock("./store.js", () => ({
  listProposals: () => [...proposals.values()],
  findProposalBySignalHash: (hash: string) => {
    const id = bySignalHash.get(hash);
    if (!id) return null;
    const p = proposals.get(id);
    if (!p) return null;
    if (p.status !== "open" && p.status !== "critical") return null;
    return p;
  },
  findRecentlyAppliedByFamilyKey: (key: string, opts: { windowDays?: number; now?: Date } = {}) => {
    const windowDays = opts.windowDays ?? 14;
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    let best: Proposal | null = null;
    let bestMs = 0;
    for (const p of proposals.values()) {
      if (p.status !== "applied") continue;
      if (!p.appliedAt) continue;
      if (!p.signals.some((s) => s.key === key)) continue;
      const ms = Date.parse(p.appliedAt);
      if (!Number.isFinite(ms)) continue;
      if (nowMs - ms > windowMs) continue;
      if (ms > bestMs) {
        best = p;
        bestMs = ms;
      }
    }
    return best;
  },
  findRecentlyRejectedByFamilyKey: (
    key: string,
    opts: { windowDays?: number; now?: Date } = {},
  ) => {
    const windowDays = opts.windowDays ?? 14;
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    let best: Proposal | null = null;
    let bestMs = 0;
    for (const p of proposals.values()) {
      if (p.status !== "rejected") continue;
      if (!p.signals.some((s) => s.key === key)) continue;
      const ms = Date.parse(p.updatedAt);
      if (!Number.isFinite(ms)) continue;
      if (nowMs - ms > windowMs) continue;
      if (ms > bestMs) {
        best = p;
        bestMs = ms;
      }
    }
    return best;
  },
  saveProposal: (input: Partial<Proposal> & { title: string }) => {
    const id = `p-${proposals.size + 1}`;
    const now = new Date().toISOString();
    const p: Proposal = {
      id,
      title: input.title,
      type: input.type ?? "memory",
      status: input.status ?? "open",
      clusterId: null,
      score: input.score ?? 0,
      signals: input.signals ?? [],
      proposedChange: input.proposedChange ?? "",
      blastRadius: input.blastRadius ?? "low",
      appliesTo: input.appliesTo ?? [],
      createdBy: input.createdBy ?? "test",
      createdAt: now,
      updatedAt: now,
      appliedAt: input.appliedAt ?? null,
      appliedBy: input.appliedBy ?? null,
      enrichedAt: null,
      enrichedBy: null,
      lastEnrichError: null,
      lastEnrichFailedAt: null,
      appliedTicketId: input.appliedTicketId ?? null,
      familyResolvedBy: input.familyResolvedBy ?? null,
    };
    proposals.set(id, p);
    for (const s of p.signals) bySignalHash.set(s.hash, id);
    return p;
  },
  updateProposal: (id: string, updates: Partial<Proposal>) => {
    const existing = proposals.get(id);
    if (!existing) return null;
    const next = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    } as Proposal;
    proposals.set(id, next);
    for (const s of next.signals) bySignalHash.set(s.hash, id);
    return next;
  },
}));

const { proposeFromSignals, rerankAll } = await import("./propose.js");
const { DEFAULT_RULE } = await import("./rank.js");

beforeEach(() => {
  proposals.clear();
  bySignalHash.clear();
});

function highSeveritySignal(hash: string, count: number): Signal {
  return {
    hash,
    source: "daemon",
    key: "daemon.fatal",
    severity: "high",
    count,
    firstSeenAt: "2026-05-13T00:00:00.000Z",
    lastSeenAt: "2026-05-15T00:00:00.000Z",
    evidencePointers: [],
  };
}

function lowFollowupSignal(hash: string): Signal {
  return {
    hash,
    source: "daemon",
    key: "daemon.fatal",
    severity: "low",
    count: 1,
    firstSeenAt: "2026-05-13T00:00:00.000Z",
    lastSeenAt: "2026-05-15T00:00:00.000Z",
    evidencePointers: [],
  };
}

describe("severity-decay guard (FRI-79)", () => {
  it("does not demote an un-enriched critical proposal when its score drops", () => {
    // Create a critical proposal from a high-severity, frequent signal.
    const initial = proposeFromSignals([highSeveritySignal("h1", 8)], {
      rule: DEFAULT_RULE,
      createdBy: "test",
    });
    expect(initial.created).toHaveLength(1);
    expect(initial.created[0].status).toBe("critical");
    expect(initial.created[0].enrichedAt).toBeNull();

    // Same signal hash reappears with a single low-severity occurrence — what
    // a normal scan window with the storm passed would look like. Without the
    // guard this proposal would silently fall back to "open" despite never
    // having been enriched.
    const followup = proposeFromSignals([lowFollowupSignal("h1")], {
      rule: DEFAULT_RULE,
      createdBy: "test",
    });
    expect(followup.updated).toHaveLength(1);
    expect(followup.updated[0].status).toBe("critical");
  });

  it("rerankAll also keeps un-enriched criticals at critical", () => {
    proposeFromSignals([highSeveritySignal("h2", 8)], {
      rule: DEFAULT_RULE,
      createdBy: "test",
    });
    const id = [...proposals.keys()][0];
    // Mutate the stored proposal so the next rerank would naturally decay it:
    // drop count and severity, leaving score below the criticalScore floor.
    const p = proposals.get(id)!;
    proposals.set(id, {
      ...p,
      signals: [lowFollowupSignal("h2")],
    });

    const { reranked } = rerankAll(DEFAULT_RULE);
    expect(reranked).toHaveLength(1);
    expect(reranked[0].status).toBe("critical");
  });

  it("does demote a critical proposal once it has been enriched", () => {
    proposeFromSignals([highSeveritySignal("h3", 8)], {
      rule: DEFAULT_RULE,
      createdBy: "test",
    });
    const id = [...proposals.keys()][0];
    proposals.set(id, {
      ...proposals.get(id)!,
      enrichedAt: "2026-05-14T00:00:00.000Z",
      enrichedBy: "claude-sonnet-4-6",
    });

    const followup = proposeFromSignals([lowFollowupSignal("h3")], {
      rule: DEFAULT_RULE,
      createdBy: "test",
    });
    expect(followup.updated).toHaveLength(1);
    expect(followup.updated[0].status).toBe("open");
  });

  it("does NOT auto-promote a fresh open proposal via the guard", () => {
    // A first-time low-severity signal must still be created as "open", not
    // critical. The guard only protects proposals that previously reached
    // critical themselves.
    const result = proposeFromSignals([lowFollowupSignal("h4")], {
      rule: DEFAULT_RULE,
      createdBy: "test",
    });
    expect(result.created).toHaveLength(1);
    expect(result.created[0].status).toBe("open");
  });
});

// ── Family-resolution (kyvl-family / friday token-spike) ─────────────────────

function tokenSpikeSignal(hash: string, agent: string, count = 1): Signal {
  return {
    hash,
    source: "usage",
    key: "usage_token_spike",
    severity: "medium",
    count,
    firstSeenAt: "2026-06-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    agent,
    evidencePointers: [],
  };
}

function preApplyProposal(
  id: string,
  signal: Signal,
  appliedAt: string,
  appliedTicketId: string | null = "ticket-78",
): void {
  const proposal: Proposal = {
    id,
    title: `usage token spike repeating on ${signal.agent}`,
    type: "code",
    status: "applied",
    clusterId: null,
    score: 60,
    signals: [signal],
    proposedChange: "(enriched body for ejku)",
    blastRadius: "medium",
    appliesTo: ["packages/evolve/src/scan.ts"],
    createdBy: "test",
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: appliedAt,
    appliedAt,
    appliedBy: "orchestrator",
    enrichedAt: "2026-05-15T01:00:00.000Z",
    enrichedBy: "claude-sonnet-4-6",
    lastEnrichError: null,
    lastEnrichFailedAt: null,
    appliedTicketId,
    familyResolvedBy: null,
  };
  proposals.set(id, proposal);
  for (const s of proposal.signals) bySignalHash.set(s.hash, id);
}

function preRejectProposal(id: string, signal: Signal, rejectedAt: string): void {
  const proposal: Proposal = {
    id,
    title: `usage token spike on ${signal.agent}`,
    type: "memory",
    status: "rejected",
    clusterId: null,
    score: 30,
    signals: [signal],
    proposedChange: "(rejected — not actionable)",
    blastRadius: "low",
    appliesTo: [],
    createdBy: "test",
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: rejectedAt,
    appliedAt: null,
    appliedBy: null,
    enrichedAt: null,
    enrichedBy: null,
    lastEnrichError: null,
    lastEnrichFailedAt: null,
    appliedTicketId: null,
    familyResolvedBy: null,
  };
  proposals.set(id, proposal);
  for (const s of proposal.signals) bySignalHash.set(s.hash, id);
}

describe("family-resolution (kyvl-family)", () => {
  it("auto-resolves a new variant as applied when a recently-applied sibling shares the signal family", () => {
    // ejku was applied 2 days ago for usage_token_spike on `friday`.
    // A new spike on the same agent today (same signal hash) would normally
    // merge — but ejku is `applied` so findProposalBySignalHash returns null
    // and a fresh proposal would be created. Family resolution kicks in:
    // the new proposal is created as `applied` with familyResolvedBy=ejku.id.
    preApplyProposal(
      "ejku",
      tokenSpikeSignal("hash-friday", "friday"),
      "2026-05-30T12:00:00.000Z",
      "ticket-78",
    );

    const newSpike = tokenSpikeSignal("hash-friday-new", "friday");
    const result = proposeFromSignals([newSpike], {
      rule: DEFAULT_RULE,
      createdBy: "test",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result.created).toHaveLength(1);
    expect(result.familyResolved).toHaveLength(1);
    expect(result.familyResolved[0].id).toBe(result.created[0].id);
    expect(result.created[0].status).toBe("applied");
    expect(result.created[0].familyResolvedBy).toBe("ejku");
    expect(result.created[0].appliedTicketId).toBe("ticket-78");
    expect(result.created[0].appliedBy).toBe("family-resolution:ejku");
    expect(result.created[0].proposedChange).toContain("Auto-resolved");
    expect(result.created[0].proposedChange).toContain("ejku");
  });

  it("auto-resolves a different-agent variant via the same family key", () => {
    // The kyvl thread spans agents — ejku was on `friday`, but kitchen and
    // path-to-prod hit the same `usage_token_spike` family with different
    // signal hashes. Family lookup is by `signal.key` (event name), not by
    // hash, so cross-agent variants are also auto-resolved.
    preApplyProposal("ejku", tokenSpikeSignal("hash-friday", "friday"), "2026-05-30T00:00:00.000Z");

    const kitchenSpike = tokenSpikeSignal("hash-kitchen", "kitchen");
    const result = proposeFromSignals([kitchenSpike], {
      rule: DEFAULT_RULE,
      createdBy: "test",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result.familyResolved).toHaveLength(1);
    expect(result.familyResolved[0].familyResolvedBy).toBe("ejku");
    expect(result.familyResolved[0].signals[0].agent).toBe("kitchen");
  });

  it("skips creation entirely when a recently-rejected sibling shares the family key", () => {
    // User explicitly rejected the family within the window. The detector
    // honors the reject: no proposal at all, but the signal is recorded in
    // familyRejected for audit.
    preRejectProposal(
      "z79r",
      tokenSpikeSignal("hash-prod", "path-to-prod"),
      "2026-05-28T00:00:00.000Z",
    );

    const newSpike = tokenSpikeSignal("hash-friday", "friday");
    const result = proposeFromSignals([newSpike], {
      rule: DEFAULT_RULE,
      createdBy: "test",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result.created).toHaveLength(0);
    expect(result.familyResolved).toHaveLength(0);
    expect(result.familyRejected).toHaveLength(1);
    expect(result.familyRejected[0].rejectedBy).toBe("z79r");
    expect(result.familyRejected[0].signalKey).toBe("usage_token_spike");
  });

  it("rejection short-circuits applied lookup (reject wins over apply)", () => {
    // Both an applied sibling AND a rejected sibling exist in window. The
    // user's reject is the more recent expression of intent — honor it.
    // (Order of insertion shouldn't matter; both are within window.)
    preApplyProposal(
      "ejku",
      tokenSpikeSignal("hash-friday-old", "friday"),
      "2026-05-25T00:00:00.000Z",
    );
    preRejectProposal(
      "z79r",
      tokenSpikeSignal("hash-prod-old", "path-to-prod"),
      "2026-05-30T00:00:00.000Z",
    );

    const newSpike = tokenSpikeSignal("hash-kitchen", "kitchen");
    const result = proposeFromSignals([newSpike], {
      rule: DEFAULT_RULE,
      createdBy: "test",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result.created).toHaveLength(0);
    expect(result.familyRejected).toHaveLength(1);
    expect(result.familyRejected[0].rejectedBy).toBe("z79r");
  });

  it("falls through to a fresh open proposal when the applied sibling is outside the window", () => {
    // A fix that decays after 14+ days deserves to re-surface. The default
    // window is 14 days; 20-day-old apply should not suppress.
    preApplyProposal("ejku", tokenSpikeSignal("hash-friday", "friday"), "2026-05-12T00:00:00.000Z");

    const newSpike = tokenSpikeSignal("hash-friday-new", "friday");
    const result = proposeFromSignals([newSpike], {
      rule: DEFAULT_RULE,
      createdBy: "test",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result.familyResolved).toHaveLength(0);
    expect(result.created).toHaveLength(1);
    expect(result.created[0].status).toBe("open");
    expect(result.created[0].familyResolvedBy).toBeNull();
  });

  it("merges into an existing open proposal of the same hash; family lookup never runs", () => {
    // Family resolution only fires when the exact-hash lookup misses. If
    // ejku is still open/critical (not yet applied) it picks up the merge
    // and no family check happens.
    proposeFromSignals([tokenSpikeSignal("hash-friday", "friday", 1)], {
      rule: DEFAULT_RULE,
      createdBy: "test",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    const secondSpike = tokenSpikeSignal("hash-friday", "friday", 3);
    const result = proposeFromSignals([secondSpike], {
      rule: DEFAULT_RULE,
      createdBy: "test",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result.created).toHaveLength(0);
    expect(result.familyResolved).toHaveLength(0);
    expect(result.familyRejected).toHaveLength(0);
    expect(result.updated).toHaveLength(1);
  });

  it("picks the most-recently-applied sibling when multiple family-matches exist", () => {
    // Two applied siblings in window. The newer one wins (its appliedTicketId
    // and id are propagated to the auto-resolved variant) — a fresher fix is
    // a stronger statement of "this family is covered."
    preApplyProposal(
      "ejku",
      tokenSpikeSignal("hash-friday-old", "friday"),
      "2026-05-20T00:00:00.000Z",
      "ticket-78",
    );
    preApplyProposal(
      "6gnh",
      tokenSpikeSignal("hash-kitchen-mid", "kitchen"),
      "2026-05-28T00:00:00.000Z",
      "ticket-92",
    );

    const newSpike = tokenSpikeSignal("hash-prod-new", "path-to-prod");
    const result = proposeFromSignals([newSpike], {
      rule: DEFAULT_RULE,
      createdBy: "test",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result.familyResolved).toHaveLength(1);
    expect(result.familyResolved[0].familyResolvedBy).toBe("6gnh");
    expect(result.familyResolved[0].appliedTicketId).toBe("ticket-92");
  });

  it("family lookup ignores siblings with a different signal.key", () => {
    // An applied `daemon.fatal` proposal must not suppress a `usage_token_spike`
    // proposal — different event families.
    preApplyProposal(
      "x1",
      {
        hash: "h-other",
        source: "daemon",
        key: "daemon.fatal",
        severity: "high",
        count: 5,
        firstSeenAt: "2026-05-25T00:00:00.000Z",
        lastSeenAt: "2026-05-25T00:00:00.000Z",
        evidencePointers: [],
      },
      "2026-05-30T00:00:00.000Z",
    );

    const spike = tokenSpikeSignal("hash-friday", "friday");
    const result = proposeFromSignals([spike], {
      rule: DEFAULT_RULE,
      createdBy: "test",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result.familyResolved).toHaveLength(0);
    expect(result.created).toHaveLength(1);
    expect(result.created[0].status).toBe("open");
  });
});
