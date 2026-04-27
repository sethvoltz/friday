import { listProposals, type Proposal } from "@friday/evolve";

export interface EvolveSidebarData {
  proposals: Proposal[];
  allStatuses: string[];
}

export function load(): EvolveSidebarData {
  let proposals: Proposal[] = [];
  try {
    proposals = listProposals();
  } catch {
    // Evolve dir may not exist yet (no scan has run).
  }

  // Highest-score first; ties broken by recency.
  proposals.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  const allStatuses = [...new Set(proposals.map((p) => p.status))].sort();
  return { proposals, allStatuses };
}
