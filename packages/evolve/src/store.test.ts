/**
 * FRI-149 — serialize → parse round-trip tests for the file-backed proposal
 * store. `serializeProposal` and `parseProposal` are pure (no IO), so these run
 * against TS source with no DB / tmpdir setup.
 *
 * Pins (AC #8): the new `builderAgent` linkage field survives a frontmatter
 * round-trip — both a set value and `null` — so the daemon scan hook's
 * `updateProposal(id, { builderAgent })` write actually persists.
 */

import { describe, expect, it } from "vitest";
import { parseProposal, serializeProposal } from "./store.js";
import type { Proposal, Signal } from "./types.js";

function makeSignal(key: string): Signal {
  const now = new Date().toISOString();
  return {
    hash: `h_${key}`,
    source: "daemon",
    key,
    severity: "high",
    count: 7,
    firstSeenAt: now,
    lastSeenAt: now,
    evidencePointers: [{ kind: "daemon", path: "logs/daemon.jsonl", line: 12 }],
  };
}

function makeProposal(id: string, overrides: Partial<Proposal> = {}): Proposal {
  const now = new Date().toISOString();
  return {
    id,
    title: `proposal ${id}`,
    type: "code",
    status: "critical",
    clusterId: null,
    score: 80,
    signals: [makeSignal("worker.exit")],
    proposedChange: "Fix the worker exit loop.\n\nDetails follow.",
    blastRadius: "low",
    appliesTo: ["daemon"],
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
    ...overrides,
  };
}

describe("serialize/parse round-trip — builderAgent (AC #8)", () => {
  it("a set builderAgent survives serialize → parse", () => {
    const p = makeProposal("x-aaaa", { builderAgent: "builder-x-aaaa" });
    const round = parseProposal(p.id, serializeProposal(p));
    expect(round.builderAgent).toBe("builder-x-aaaa");
  });

  it("a null builderAgent round-trips as null (not undefined, not a string)", () => {
    const p = makeProposal("y-bbbb", { builderAgent: null });
    const round = parseProposal(p.id, serializeProposal(p));
    expect(round.builderAgent).toBe(null);
  });

  it("the full proposal (incl. builderAgent) round-trips field-for-field", () => {
    const p = makeProposal("z-cccc", {
      builderAgent: "builder-z-cccc",
      appliedTicketId: "FRI-999",
      familyResolvedBy: "z-prior-dddd",
    });
    const round = parseProposal(p.id, serializeProposal(p));
    expect(round).toMatchObject({
      id: "z-cccc",
      type: "code",
      status: "critical",
      builderAgent: "builder-z-cccc",
      appliedTicketId: "FRI-999",
      familyResolvedBy: "z-prior-dddd",
    });
    expect(round.proposedChange).toBe(p.proposedChange);
    expect(round.signals).toEqual(p.signals);
  });
});
