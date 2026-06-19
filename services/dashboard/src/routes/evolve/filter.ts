import type { Proposal, ProposalStatus } from "@friday/evolve";

export const TERMINAL_STATUSES: readonly ProposalStatus[] = [
  "applied",
  "auto-resolved",
  "rejected",
  "superseded",
];

export function isTerminal(status: ProposalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function filterProposals(
  proposals: readonly Proposal[],
  showCompleted: boolean,
): Proposal[] {
  if (showCompleted) return [...proposals];
  return proposals.filter((p) => !isTerminal(p.status));
}

export function countActionable(proposals: readonly Proposal[]): number {
  let n = 0;
  for (const p of proposals) if (!isTerminal(p.status)) n++;
  return n;
}
