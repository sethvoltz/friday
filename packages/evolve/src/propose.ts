import {
  findProposalBySignalHash,
  listProposals,
  saveProposal,
  updateProposal,
  type Proposal,
  type ProposalStatus,
  type Signal,
} from "./store.js";
import { isCritical, scoreProposal, type CriticalityRule } from "./rank.js";

export interface ProposeOptions {
  rule: CriticalityRule;
  /** Who is creating the proposals — typically the scheduled agent's name. */
  createdBy: string;
}

export interface ProposeResult {
  created: Proposal[];
  updated: Proposal[];
  promotedToCritical: Proposal[];
}

/**
 * Phase 1 proposal generation: deterministic, no LLM.
 *
 * For each raw signal:
 *   - If an open/critical proposal already covers the signal hash, merge the
 *     new occurrence count and re-rank.
 *   - Otherwise, create a fresh proposal with a templated title and body
 *     based on the event type.
 *
 * The LLM-driven phase (clustering, prose, code suggestions) lands in later
 * phases; phase 1's job is to validate that the data model holds up and the
 * scoring picks the right items as critical.
 */
export function proposeFromSignals(signals: Signal[], opts: ProposeOptions): ProposeResult {
  const result: ProposeResult = { created: [], updated: [], promotedToCritical: [] };

  for (const signal of signals) {
    const existing = findProposalBySignalHash(signal.hash);

    if (existing) {
      // Merge: replace the matching signal entry, recompute score & criticality.
      const mergedSignals = existing.signals.map((s) => (s.hash === signal.hash ? signal : s));
      const score = scoreProposal({ signals: mergedSignals, blastRadius: existing.blastRadius });
      const wasCritical = existing.status === "critical";
      const nowCritical = isCritical({ score, signals: mergedSignals }, opts.rule);
      const status: ProposalStatus = nowCritical ? "critical" : existing.status === "critical" ? "open" : existing.status;

      const updated = updateProposal(existing.id, { signals: mergedSignals, score, status });
      if (updated) {
        result.updated.push(updated);
        if (!wasCritical && nowCritical) result.promotedToCritical.push(updated);
      }
      continue;
    }

    const draft = draftFromSignal(signal);
    const score = scoreProposal({ signals: [signal], blastRadius: draft.blastRadius });
    const critical = isCritical({ score, signals: [signal] }, opts.rule);
    const status: ProposalStatus = critical ? "critical" : "open";

    const created = saveProposal({
      title: draft.title,
      type: draft.type,
      proposedChange: draft.body,
      signals: [signal],
      blastRadius: draft.blastRadius,
      appliesTo: draft.appliesTo,
      createdBy: opts.createdBy,
      score,
      status,
    });
    result.created.push(created);
    if (critical) result.promotedToCritical.push(created);
  }

  return result;
}

interface Draft {
  title: string;
  type: Proposal["type"];
  body: string;
  blastRadius: Proposal["blastRadius"];
  appliesTo: string[];
}

/**
 * Templated proposal body keyed off the daemon event name. The `friday evolve
 * enrich` pass replaces this body with Sonnet-generated root-cause analysis +
 * suggested change once a proposal lands; until then this stub gives the
 * dashboard and the meta-agent something readable.
 */
function draftFromSignal(signal: Signal): Draft {
  const agent = signal.agent ? ` for agent \`${signal.agent}\`` : "";
  const occurrences = `${signal.count} occurrence${signal.count === 1 ? "" : "s"} between ${signal.firstSeenAt} and ${signal.lastSeenAt}`;

  const body = [
    `**Signal**: \`${signal.key}\`${agent}`,
    "",
    `**Frequency**: ${occurrences}.`,
    "",
    `**Severity**: ${signal.severity}.`,
    "",
    `**Evidence**: ${signal.evidencePointers.length} pointer${signal.evidencePointers.length === 1 ? "" : "s"} into \`${signal.source}\` source.`,
    "",
    `_Awaiting enrichment. Run \`friday evolve enrich\` to replace this with root-cause analysis and a concrete suggested change._`,
  ].join("\n");

  // Phase 1 only emits "memory" type proposals: the safest surface to apply
  // to (low blast radius). The meta-agent records the pattern as a lesson;
  // future phases promote some of these to prompt/config/code proposals.
  return {
    title: titleFor(signal.key, signal.agent),
    type: "memory",
    body,
    blastRadius: "low",
    appliesTo: [],
  };
}

function titleFor(event: string, agent?: string): string {
  const friendly = event.replace(/_/g, " ");
  if (agent) return `${friendly} repeating on ${agent}`;
  return `${friendly} repeating`;
}

/**
 * Bulk re-rank: recompute scores and criticality for every open/critical
 * proposal. Used at the end of a scan run after merges happen.
 */
export function rerankAll(rule: CriticalityRule): { reranked: Proposal[]; promoted: Proposal[] } {
  const reranked: Proposal[] = [];
  const promoted: Proposal[] = [];

  for (const p of listProposals()) {
    if (p.status !== "open" && p.status !== "critical") continue;
    const score = scoreProposal(p);
    const wasCritical = p.status === "critical";
    const nowCritical = isCritical({ score, signals: p.signals }, rule);
    const status: ProposalStatus = nowCritical ? "critical" : "open";
    if (score === p.score && status === p.status) continue;

    const updated = updateProposal(p.id, { score, status });
    if (updated) {
      reranked.push(updated);
      if (!wasCritical && nowCritical) promoted.push(updated);
    }
  }

  return { reranked, promoted };
}
