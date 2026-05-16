import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Proposal, Signal } from "./types.js";

const proposals = new Map<string, Proposal>();
const bySignalHash = new Map<string, string>();

vi.mock("./store.js", () => ({
  listProposals: () => [...proposals.values()],
  findProposalBySignalHash: (hash: string) => {
    const id = bySignalHash.get(hash);
    return id ? (proposals.get(id) ?? null) : null;
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
      appliedAt: null,
      appliedBy: null,
      enrichedAt: null,
      enrichedBy: null,
      lastEnrichError: null,
      lastEnrichFailedAt: null,
      appliedTicketId: null,
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
