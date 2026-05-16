/**
 * Bridge raw signals → proposals. Deterministic; no LLM. The enrich pass
 * later replaces templated bodies with Sonnet-generated content.
 *
 * Ported nearly verbatim from old SlackAgents Friday.
 */

import {
  findProposalBySignalHash,
  listProposals,
  saveProposal,
  updateProposal,
} from "./store.js";
import type { Proposal, ProposalStatus, Signal } from "./types.js";
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

export function proposeFromSignals(
  signals: Signal[],
  opts: ProposeOptions,
): ProposeResult {
  const result: ProposeResult = {
    created: [],
    updated: [],
    promotedToCritical: [],
  };

  for (const signal of signals) {
    const existing = findProposalBySignalHash(signal.hash);

    if (existing) {
      const mergedSignals = existing.signals.map((s) =>
        s.hash === signal.hash ? signal : s,
      );
      const score = scoreProposal({
        signals: mergedSignals,
        blastRadius: existing.blastRadius,
      });
      const wasCritical = existing.status === "critical";
      const nowCritical = isCritical(
        { score, signals: mergedSignals },
        opts.rule,
      );
      // Severity-decay guard (FRI-79): a proposal that previously reached
      // `critical` but has never been enriched must not silently fall back
      // to `open`. Otherwise a failing enrichment pass masks severity — the
      // proposal looks routine on the dashboard while its root signal still
      // fires. Only ones that already touched critical are protected; we
      // don't auto-promote new proposals here.
      const protectCritical =
        existing.status === "critical" && existing.enrichedAt === null;
      const status: ProposalStatus = nowCritical
        ? "critical"
        : protectCritical
          ? "critical"
          : existing.status === "critical"
            ? "open"
            : existing.status;

      const updated = updateProposal(existing.id, {
        signals: mergedSignals,
        score,
        status,
      });
      if (updated) {
        result.updated.push(updated);
        if (!wasCritical && nowCritical) result.promotedToCritical.push(updated);
      }
      continue;
    }

    const draft = draftFromSignal(signal);
    const score = scoreProposal({
      signals: [signal],
      blastRadius: draft.blastRadius,
    });
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
    `_Awaiting enrichment. Run \`evolve_enrich\` (or \`friday evolve enrich\`) to replace this with root-cause analysis and a concrete suggested change._`,
  ].join("\n");

  return {
    title: titleFor(signal.key, signal.agent),
    type: "memory",
    body,
    blastRadius: "low",
    appliesTo: [],
  };
}

function titleFor(event: string, agent?: string): string {
  const friendly = event.replace(/[._-]/g, " ");
  // Preference-class signals are declarative, not recurring crashes; "repeating"
  // wording doesn't fit. Same for affirmative declarations the user makes once.
  const declarative =
    event.startsWith("preference_") ||
    event === "directive" ||
    event === "role_context" ||
    event === "external_pointer";
  if (declarative) {
    return agent
      ? `User signal: ${friendly} (from ${agent})`
      : `User signal: ${friendly}`;
  }
  if (agent) return `${friendly} repeating on ${agent}`;
  return `${friendly} repeating`;
}

/**
 * Recompute scores + criticality for every open/critical proposal. Used at the
 * end of a scan run after merges.
 */
export function rerankAll(rule: CriticalityRule): {
  reranked: Proposal[];
  promoted: Proposal[];
} {
  const reranked: Proposal[] = [];
  const promoted: Proposal[] = [];

  for (const p of listProposals()) {
    if (p.status !== "open" && p.status !== "critical") continue;
    const score = scoreProposal(p);
    const wasCritical = p.status === "critical";
    const nowCritical = isCritical({ score, signals: p.signals }, rule);
    // See severity-decay guard in proposeFromSignals: an un-enriched critical
    // sticks at critical until enrichment lands.
    const protectCritical = wasCritical && p.enrichedAt === null;
    const status: ProposalStatus =
      nowCritical || protectCritical ? "critical" : "open";
    if (score === p.score && status === p.status) continue;

    const updated = updateProposal(p.id, { score, status });
    if (updated) {
      reranked.push(updated);
      if (!wasCritical && nowCritical) promoted.push(updated);
    }
  }

  return { reranked, promoted };
}
