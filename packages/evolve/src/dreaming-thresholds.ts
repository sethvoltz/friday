/**
 * FRI-26 Memory Dreaming — per-category auto-apply thresholds + dedup gate.
 *
 * Decision C: `person` IS promotable but auto-applied ONLY at score >= 80
 * (PII + the FRI-141 passive-recall exclusion semantics); the other four
 * categories keep their own per-category bars. A dream proposal auto-applies
 * iff `proposal.score >= CATEGORY_AUTOAPPLY_THRESHOLD[category]`; below that it
 * stays `open` and bubbles up for human review via evolve_list (AC5, AC7a).
 * These gate auto-WRITE only — they do not touch the underlying
 * scoreProposal/isCritical math in rank.ts.
 *
 * `DreamCategory` lives HERE (it has NO imports) so the other dreaming modules
 * can import it without creating an import cycle.
 */

export type DreamCategory = "user" | "feedback" | "project" | "reference" | "person" | "none";

/** Per-category auto-apply thresholds (Decision C). person gated highest. */
export const CATEGORY_AUTOAPPLY_THRESHOLD: Record<Exclude<DreamCategory, "none">, number> = {
  feedback: 60,
  user: 55,
  project: 50,
  reference: 45,
  person: 80,
};

/**
 * searchMemories dedup gate: a score >= 5 guarantees at least one exact-tag
 * match (tag exact = +5 in search.ts scoring), the spec's "at least one
 * exact-tag match" bar. Used for both pre-promotion dedup and hygiene merge.
 */
export const DREAM_DEDUP_MIN_SCORE = 5;
