/**
 * @friday/evolve types. Shape ports from the old SlackAgents Friday so the
 * existing scan/enrich/cluster pipeline can be lifted in a follow-up sub-phase
 * without re-shaping the on-disk format.
 */

export type ProposalStatus =
  | "open"
  | "critical"
  | "approved"
  | "rejected"
  | "applied"
  | "superseded";

export type ProposalType = "memory" | "prompt" | "config" | "code";

export type BlastRadius = "low" | "medium" | "high";

export type SignalSource =
  | "daemon"
  | "usage"
  | "transcript"
  | "feedback"
  | "friction";

export type SignalSeverity = "low" | "medium" | "high";

export interface EvidencePointer {
  kind: SignalSource;
  path: string;
  line?: number;
  sessionId?: string;
}

export interface Signal {
  /** Stable hash that groups identical signal occurrences across runs. */
  hash: string;
  source: SignalSource;
  /** Human-readable identifier within the source (e.g. daemon event name). */
  key: string;
  severity: SignalSeverity;
  /** Number of occurrences observed in the analyzed window. */
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Optional name of the agent involved (never a `scheduled-meta-*` agent). */
  agent?: string;
  evidencePointers: EvidencePointer[];
}

export interface Proposal {
  id: string;
  title: string;
  type: ProposalType;
  status: ProposalStatus;
  clusterId: string | null;
  /** 0-100 score driven by severity, frequency, blast radius, fix cost. */
  score: number;
  signals: Signal[];
  /** Free-text rationale + suggested change (markdown body). */
  proposedChange: string;
  blastRadius: BlastRadius;
  /** What surfaces this proposal would touch (e.g. "agent.systemPrompt"). */
  appliesTo: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
  appliedBy: string | null;
  /**
   * Set by `evolve enrich`. Marks when the body was rewritten by the
   * Sonnet pass. Stale if `updatedAt > enrichedAt` (signals changed since).
   */
  enrichedAt: string | null;
  /** Model used for the enrichment call. NULL if the body is still templated. */
  enrichedBy: string | null;
  /** Error message from the last failed enrichment attempt. Cleared on success. */
  lastEnrichError: string | null;
  /** ISO timestamp of the last failed enrichment attempt. Cleared on success. */
  lastEnrichFailedAt: string | null;
  /**
   * If applied via a ticket, the resulting Friday ticket id. Lets the
   * dashboard link a closed proposal to its trackable work.
   */
  appliedTicketId: string | null;
}
