/**
 * FRI-149 — unit tests for the pure builder-escalation planner.
 *
 * These run against TS source via vitest (no build needed for evolve-own
 * tests). They pin the owner-settled trigger band — critical AND code AND a
 * high-severity signal — the FULL-id naming scheme, union dedup across both
 * promote surfaces, and the no-merge / evolve_get / proposal-id content of the
 * generated first-turn prompt.
 */

import { describe, expect, it } from "vitest";
import { builderEscalationPlan } from "./builder-escalation.js";
import type { Proposal, ProposalStatus, ProposalType, Signal, SignalSeverity } from "./types.js";

function makeSignal(key: string, severity: SignalSeverity = "high"): Signal {
  const now = new Date().toISOString();
  return {
    hash: `h_${key}_${severity}`,
    source: "daemon",
    key,
    severity,
    // count 10 keeps a medium-severity proposal critical via the frequency
    // branch of isCritical (count >= 5), so AC #3 isolates the high-filter.
    count: 10,
    firstSeenAt: now,
    lastSeenAt: now,
    evidencePointers: [],
  };
}

function makeProposal(
  id: string,
  opts: {
    status?: ProposalStatus;
    type?: ProposalType;
    severity?: SignalSeverity;
    signalKey?: string;
  } = {},
): Proposal {
  const now = new Date().toISOString();
  return {
    id,
    title: `proposal ${id}`,
    type: opts.type ?? "code",
    status: opts.status ?? "critical",
    clusterId: null,
    score: 80,
    signals: [makeSignal(opts.signalKey ?? "worker.exit", opts.severity ?? "high")],
    proposedChange: "x",
    blastRadius: "low",
    appliesTo: [],
    createdBy: "test",
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
  };
}

describe("builderEscalationPlan", () => {
  it("selects only critical + code + high-severity-signal proposals (AC #1)", () => {
    const plan = builderEscalationPlan([
      makeProposal("p_fix-aaaa", { status: "critical", type: "code", severity: "high" }),
    ]);
    expect(plan.length).toBe(1);
    expect(plan[0]).toMatchObject({ type: "builder", name: "builder-p_fix-aaaa" });
    // Reason carries the proposal id verbatim.
    expect(plan[0].reason).toContain("p_fix-aaaa");
  });

  it("filters out non-code proposals — memory/prompt/config (AC #2)", () => {
    const plan = builderEscalationPlan([
      makeProposal("p_mem-aaaa", { type: "memory", severity: "high" }),
      makeProposal("p_prompt-bbbb", { type: "prompt", severity: "high" }),
      makeProposal("p_config-cccc", { type: "config", severity: "high" }),
    ]);
    expect(plan).toEqual([]);
  });

  it("filters out critical code proposals with no high-severity signal (AC #3)", () => {
    // Critical reached via count >= 5 on a medium-severity signal, NOT via a
    // high-severity signal — so the high-filter must exclude it.
    const plan = builderEscalationPlan([
      makeProposal("p_med-aaaa", { status: "critical", type: "code", severity: "medium" }),
    ]);
    expect(plan).toEqual([]);
  });

  it("filters out non-critical proposals even when code + high (open/applied/rejected)", () => {
    const plan = builderEscalationPlan([
      makeProposal("p_open-aaaa", { status: "open", type: "code", severity: "high" }),
      makeProposal("p_applied-bbbb", { status: "applied", type: "code", severity: "high" }),
      makeProposal("p_rejected-cccc", { status: "rejected", type: "code", severity: "high" }),
    ]);
    expect(plan).toEqual([]);
  });

  it("dedupes by id across both promote surfaces; FULL-id naming (AC #4)", () => {
    // Simulates `[...promotedToCritical, ...reranked.promoted]` with p1 in both.
    const p1 = makeProposal("p_one-aaaa", { status: "critical", type: "code", severity: "high" });
    const p2 = makeProposal("p_two-bbbb", { status: "critical", type: "code", severity: "high" });
    const plan = builderEscalationPlan([p1, p2, p1]);
    expect(plan.length).toBe(2);
    expect(plan.map((r) => r.name)).toEqual(["builder-p_one-aaaa", "builder-p_two-bbbb"]);
  });

  it("uses the FULL id so ids sharing the first 12 chars stay distinct", () => {
    const a = "daemon-worker-exit-aaaa";
    const b = "daemon-worker-exit-bbbb";
    expect(a.slice(0, 12)).toBe(b.slice(0, 12)); // guards the test's premise
    const plan = builderEscalationPlan([
      makeProposal(a, { status: "critical", type: "code", severity: "high" }),
      makeProposal(b, { status: "critical", type: "code", severity: "high" }),
    ]);
    expect(plan.length).toBe(2);
    expect(plan[0].name).toBe("builder-daemon-worker-exit-aaaa");
    expect(plan[1].name).toBe("builder-daemon-worker-exit-bbbb");
    expect(plan[0].name).not.toBe(plan[1].name);
  });

  it("the generated prompt forbids merging and mandates evolve_get + the proposal id (AC #12 planner)", () => {
    const plan = builderEscalationPlan([
      makeProposal("p_fix-aaaa", { status: "critical", type: "code", severity: "high" }),
    ]);
    expect(plan.length).toBe(1);
    const prompt = plan[0].prompt;
    expect(prompt.toLowerCase()).toContain("do not");
    expect(prompt.toLowerCase()).toContain("merge");
    expect(prompt).toContain("gh pr merge");
    expect(prompt).toContain("evolve_get");
    expect(prompt).toContain("p_fix-aaaa");
  });
});
