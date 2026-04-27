import type { BlastRadius, Proposal, Signal, SignalSeverity } from "./store.js";

const SEVERITY_WEIGHT: Record<SignalSeverity, number> = {
  high: 40,
  medium: 20,
  low: 5,
};

const BLAST_PENALTY: Record<BlastRadius, number> = {
  low: 0,
  medium: 5,
  high: 15,
};

/**
 * Compute a 0-100 score for a proposal.
 *
 * Components:
 *   - Severity ceiling: the highest-severity signal sets a floor.
 *   - Frequency boost: log2-scaled so 5 occurrences is meaningfully more
 *     than 1, but 50 isn't 10x more than 5.
 *   - Blast-radius penalty: high-blast proposals get pulled down a bit so
 *     low-risk wins surface first when scores are otherwise close.
 */
export function scoreProposal(p: Pick<Proposal, "signals" | "blastRadius">): number {
  if (p.signals.length === 0) return 0;

  let highestSeverity: SignalSeverity = "low";
  let totalCount = 0;
  for (const s of p.signals) {
    totalCount += s.count;
    if (rank(s.severity) > rank(highestSeverity)) highestSeverity = s.severity;
  }

  const severityFloor = SEVERITY_WEIGHT[highestSeverity];
  const frequencyBoost = Math.min(40, Math.log2(totalCount + 1) * 12);
  const distinctSignalsBoost = Math.min(20, (p.signals.length - 1) * 5);
  const penalty = BLAST_PENALTY[p.blastRadius];

  const raw = severityFloor + frequencyBoost + distinctSignalsBoost - penalty;
  return clamp(Math.round(raw), 0, 100);
}

/**
 * Apply criticality rules. A proposal is critical when its score crosses the
 * threshold AND at least one signal is high-severity OR has fired enough
 * times in the window to indicate a sustained pattern.
 */
export interface CriticalityRule {
  criticalScore: number;
  criticalFrequency: number;
}

export function isCritical(p: Pick<Proposal, "score" | "signals">, rule: CriticalityRule): boolean {
  if (p.score < rule.criticalScore) return false;
  for (const s of p.signals) {
    if (s.severity === "high") return true;
    if (s.count >= rule.criticalFrequency) return true;
  }
  return false;
}

function rank(s: SignalSeverity): number {
  return s === "high" ? 3 : s === "medium" ? 2 : 1;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
