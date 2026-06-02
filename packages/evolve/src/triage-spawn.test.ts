/**
 * FRI-40 — unit tests for the pure triage-spawn planner.
 *
 * These run against TS source via vitest (no build needed for evolve-own
 * tests). They pin:
 *   - AC #2: critical proposals map to `triage-<FULL id>` helper requests with
 *     a reason that contains the proposal id verbatim.
 *   - AC #3: the FULL-id naming scheme — two ids sharing the first 12 chars
 *     must produce DISTINCT names (a `slice(0,12)` scheme would collide).
 *   - Non-critical proposals are filtered out entirely.
 *   - Union dedup: feeding the same proposal twice (as it would appear when
 *     present in BOTH promote surfaces) yields a single request.
 */

import { describe, expect, it } from "vitest";
import { triageSpawnPlan } from "./triage-spawn.js";
import type { Proposal, ProposalStatus, Signal } from "./types.js";

function makeSignal(key: string): Signal {
  const now = new Date().toISOString();
  return {
    hash: `h_${key}`,
    source: "daemon",
    key,
    severity: "high",
    count: 10,
    firstSeenAt: now,
    lastSeenAt: now,
    evidencePointers: [],
  };
}

function makeProposal(id: string, status: ProposalStatus, signalKey = "worker.exit"): Proposal {
  const now = new Date().toISOString();
  return {
    id,
    title: `proposal ${id}`,
    type: "code",
    status,
    clusterId: null,
    score: 80,
    signals: [makeSignal(signalKey)],
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
  };
}

describe("triageSpawnPlan", () => {
  it("maps two distinct critical proposals to triage-<FULL id> helper requests (AC #2)", () => {
    const plan = triageSpawnPlan([
      makeProposal("p_one-aaaa", "critical", "worker.exit"),
      makeProposal("p_two-bbbb", "critical", "daemon.fatal"),
    ]);

    expect(plan.length).toBe(2);
    expect(plan).toMatchObject([
      { type: "helper", name: "triage-p_one-aaaa", reason: /proposal p_one-aaaa/ },
      { type: "helper", name: "triage-p_two-bbbb", reason: /proposal p_two-bbbb/ },
    ]);
    // Reason must name the originating signal verbatim too.
    expect(plan[0].reason).toContain("worker.exit");
    expect(plan[1].reason).toContain("daemon.fatal");
    // Prompts must carry the read-only mandate and the proposal id.
    expect(plan[0].prompt).toContain("p_one-aaaa");
    expect(plan[0].prompt).toContain("evolve_get");
    expect(plan[0].prompt).toContain("mail_send");
    expect(plan[0].prompt.toLowerCase()).toContain("read-only");
  });

  it("uses the FULL id so ids sharing the first 12 chars stay distinct (AC #3 collision)", () => {
    // "daemon-worker-exit-aaaa" and "...-bbbb" share their first 12 chars
    // ("daemon-worke"). A slice(0,12) scheme would name both "triage-daemon-worke".
    const a = "daemon-worker-exit-aaaa";
    const b = "daemon-worker-exit-bbbb";
    expect(a.slice(0, 12)).toBe(b.slice(0, 12)); // guards the test's premise

    const plan = triageSpawnPlan([makeProposal(a, "critical"), makeProposal(b, "critical")]);

    expect(plan.length).toBe(2);
    expect(plan[0].name).toBe("triage-daemon-worker-exit-aaaa");
    expect(plan[1].name).toBe("triage-daemon-worker-exit-bbbb");
    expect(plan[0].name).not.toBe(plan[1].name);
  });

  it("filters out non-critical proposals (open/applied/rejected)", () => {
    const plan = triageSpawnPlan([
      makeProposal("p_open-aaaa", "open"),
      makeProposal("p_applied-bbbb", "applied"),
      makeProposal("p_rejected-cccc", "rejected"),
    ]);
    expect(plan).toEqual([]);
  });

  it("dedupes by id when the same proposal appears in both surfaces (union dedup)", () => {
    // Simulates `[...promotedToCritical, ...reranked.promoted]` where p1 is in
    // both — proves both surfaces are consumed AND deduped.
    const p1 = makeProposal("p_one-aaaa", "critical");
    const p2 = makeProposal("p_two-bbbb", "critical");
    const plan = triageSpawnPlan([p1, p2, p1]);

    expect(plan.length).toBe(2);
    const names = plan.map((r) => r.name);
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(["triage-p_one-aaaa", "triage-p_two-bbbb"]);
  });

  it("falls back to signal key 'unknown' when a critical proposal has no signals", () => {
    const p = makeProposal("p_nosig-dddd", "critical");
    p.signals = [];
    const plan = triageSpawnPlan([p]);
    expect(plan.length).toBe(1);
    expect(plan[0].reason).toContain("signal unknown");
    expect(plan[0].name).toBe("triage-p_nosig-dddd");
  });
});
