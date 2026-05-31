import { describe, expect, it } from "vitest";
import type { Proposal, ProposalStatus } from "@friday/evolve";
import {
  TERMINAL_STATUSES,
  countActionable,
  filterProposals,
  isTerminal,
} from "./filter.js";

function p(id: string, status: ProposalStatus): Proposal {
  return {
    id,
    title: `proposal ${id}`,
    type: "memory",
    status,
    clusterId: null,
    score: 0,
    signals: [],
    proposedChange: "",
    blastRadius: "low",
    appliesTo: [],
    createdBy: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    appliedAt: null,
    appliedBy: null,
    enrichedAt: null,
    enrichedBy: null,
    lastEnrichError: null,
    lastEnrichFailedAt: null,
    appliedTicketId: null,
  };
}

describe("evolve filter", () => {
  const rows: Proposal[] = [
    p("o", "open"),
    p("c", "critical"),
    p("a", "approved"),
    p("ap", "applied"),
    p("r", "rejected"),
    p("s", "superseded"),
  ];

  it("treats applied / rejected / superseded as terminal", () => {
    expect(TERMINAL_STATUSES).toEqual(["applied", "rejected", "superseded"]);
    expect(isTerminal("applied")).toBe(true);
    expect(isTerminal("rejected")).toBe(true);
    expect(isTerminal("superseded")).toBe(true);
  });

  it("treats open / critical / approved as non-terminal", () => {
    expect(isTerminal("open")).toBe(false);
    expect(isTerminal("critical")).toBe(false);
    expect(isTerminal("approved")).toBe(false);
  });

  it("filterProposals(false) hides terminal-status rows", () => {
    const visible = filterProposals(rows, false);
    expect(visible.map((r) => r.id)).toEqual(["o", "c", "a"]);
  });

  it("filterProposals(true) returns every row, in order", () => {
    const visible = filterProposals(rows, true);
    expect(visible.map((r) => r.id)).toEqual(["o", "c", "a", "ap", "r", "s"]);
  });

  it("filterProposals does not mutate the input", () => {
    const input = [...rows];
    filterProposals(input, false);
    filterProposals(input, true);
    expect(input.map((r) => r.id)).toEqual(["o", "c", "a", "ap", "r", "s"]);
  });

  it("countActionable counts non-terminal rows", () => {
    expect(countActionable(rows)).toBe(3);
    expect(countActionable([])).toBe(0);
    expect(countActionable([p("x", "applied"), p("y", "rejected")])).toBe(0);
    expect(countActionable([p("x", "open"), p("y", "applied")])).toBe(1);
  });
});
