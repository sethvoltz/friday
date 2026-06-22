/**
 * FRI-26 Memory Dreaming — corpus-wide anti-rot pass (Refinement 1).
 *
 * `runHygiene` walks the full `memory_entries` corpus once per dream run and
 * does two things, both NON-destructive:
 *
 *   (a) Merge near-duplicates. Two entries whose `searchMemories` similarity
 *       clears `mergeMinScore` are folded into one: the higher-`recallCount`
 *       entry SURVIVES (its content + tags absorb the other's), the absorbed
 *       entry gains an `archived` tag. Survivor recall metadata is PRESERVED by
 *       omitting `recallCount`/`lastRecalledAt` from the survivor's patch
 *       (updateEntry spreads `...cur, ...patch`, so an omitted field is kept).
 *
 *   (b) Flag + archive cold entries. An entry that is rarely recalled
 *       (`recallCount <= coldRecallMax`), has not been recalled recently
 *       (`lastRecalledAt` null OR older than `coldRecallAgeDays`), and has
 *       cleared the new-entry grace window (`createdAt` older than `graceDays`)
 *       is surfaced in `decayCandidates` AND archived via the `archived` tag.
 *
 * Preserve-over-delete is absolute here: hygiene NEVER hard-deletes. It MUST
 * NOT import or reference the memory store's hard-delete primitive (AC10) —
 * pruning is only ever an `updateEntry` that adds the `archived` tag. The
 * daemon passive-recall hook passes `excludeTags: ['person', 'archived']`, so an archived
 * entry stops surfacing in recall while its row + markdown file stay on disk.
 */

import { getEntry, searchMemories, updateEntry, type MemoryEntry } from "@friday/memory";
import { DREAM_DEDUP_MIN_SCORE } from "./dreaming-thresholds.js";

const ARCHIVED_TAG = "archived";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MergeAction {
  /** Kept entry (higher recallCount). */
  survivorId: string;
  /** Archived entry (content/tags folded into survivor, gains `archived` tag). */
  absorbedId: string;
  /** Human-readable reason, e.g. "near-duplicate, similarity score N". */
  reason: string;
}

export interface HygieneReport {
  merged: MergeAction[];
  /** ids flagged cold (D1 rule). */
  decayCandidates: string[];
  /** ids that gained the `archived` tag this pass (merge-absorbed + cold). */
  archived: string[];
}

export interface HygieneOptions {
  /** Cold iff recallCount <= this. D1 default 1. */
  coldRecallMax?: number;
  /** Cold iff lastRecalledAt is null OR older than this many days. D1 default 60. */
  coldRecallAgeDays?: number;
  /** New-entry grace: cold only once createdAt is older than this. D1 default 30. */
  graceDays?: number;
  /** searchMemories similarity bar for a merge. Default DREAM_DEDUP_MIN_SCORE (5). */
  mergeMinScore?: number;
  /** Pin "now" for deterministic tests. */
  now?: Date;
}

/** Union two tag lists, dropping duplicates, preserving first-seen order. */
function unionTags(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/** Fold an absorbed entry's content beneath a survivor's, separated by a rule.
 *  Both the cumulative-survivor accumulator and the loser-flush path use this
 *  exact shape so all folded memories read consistently. */
function foldInto(survivorContent: string, absorbedContent: string): string {
  return [survivorContent.trim(), "", "---", "", absorbedContent.trim()].join("\n");
}

export async function runHygiene(
  entries: MemoryEntry[],
  opts: HygieneOptions = {},
): Promise<HygieneReport> {
  const coldRecallMax = opts.coldRecallMax ?? 1;
  const coldRecallAgeDays = opts.coldRecallAgeDays ?? 60;
  const graceDays = opts.graceDays ?? 30;
  const mergeMinScore = opts.mergeMinScore ?? DREAM_DEDUP_MIN_SCORE;
  const nowMs = (opts.now ?? new Date()).getTime();

  const report: HygieneReport = { merged: [], decayCandidates: [], archived: [] };

  // Entries already consumed this pass (absorbed into a survivor) OR already
  // carrying the archive marker on entry. They are skipped as both candidates
  // and dedup targets so a merged-away (or pre-archived) entry is never
  // re-evaluated as a later survivor/loser and never re-flagged as cold. Seeding
  // it with the input's already-`archived` ids makes a re-run over an
  // already-archived corpus a no-op (idempotent: nothing left to absorb).
  const archivedThisPass = new Set<string>();
  for (const e of entries) {
    if (e.tags.includes(ARCHIVED_TAG)) archivedThisPass.add(e.id);
  }

  // ── (a) Merge near-duplicates ──────────────────────────────────────────
  for (const entry of entries) {
    // Skip entries already absorbed/archived this pass (or pre-archived on
    // input). An entry that became a loser earlier must never be re-processed
    // as a survivor — that would resurrect a merged-away row and re-fold it.
    if (archivedThisPass.has(entry.id)) continue;

    try {
      const hits = await searchMemories({ query: entry.title, limit: 5 });

      // Cumulative fold accumulators for `entry` AS THE SURVIVOR. When one
      // survivor absorbs ≥2 near-dups in this pass, each fold must build on the
      // PRIOR fold's result — reading the stale original `entry.content`/`tags`
      // for every loser would make the second write clobber the first, silently
      // destroying the first loser's content+tags (F1 / preserve-over-delete).
      // We accumulate locally and patch ONCE from the accumulators, still
      // OMITTING recallCount/lastRecalledAt so the survivor keeps its recall
      // metadata. The accumulator seeds from the FRESH store row (not the stale
      // input snapshot) so any content an EARLIER outer iteration already folded
      // into `entry` (it was a higher-recall survivor in someone else's pass) is
      // carried forward rather than overwritten.
      const fresh = (await getEntry(entry.id)) ?? entry;
      let foldedContent = fresh.content;
      let foldedTags = [...fresh.tags];
      let absorbedAny = false;

      for (const hit of hits) {
        const other = hit.entry;
        if (other.id === entry.id) continue;
        if (archivedThisPass.has(other.id)) continue;
        if (hit.score < mergeMinScore) continue;

        // Survivor = higher recallCount; ties keep `entry` (the outer loop's
        // candidate). If `other` out-recalls `entry`, `entry` is the loser:
        // fold `entry` into `other` (reading `other`'s FRESH store row so any
        // prior absorptions into `other` are preserved), archive `entry`, and
        // STOP — a loser must not go on to absorb anything else.
        if (other.recallCount > entry.recallCount) {
          try {
            // Flush whatever `entry` has already accumulated as a survivor in
            // this same iteration into `other`, so no absorbed content is lost
            // when `entry` flips to loser mid-pass.
            const otherFresh = (await getEntry(other.id)) ?? other;
            await updateEntry(other.id, {
              content: foldInto(otherFresh.content, foldedContent),
              tags: unionTags(otherFresh.tags, foldedTags),
            });
            await updateEntry(entry.id, { tags: unionTags(fresh.tags, [ARCHIVED_TAG]) });
            archivedThisPass.add(entry.id);
            report.merged.push({
              survivorId: other.id,
              absorbedId: entry.id,
              reason: `near-duplicate, similarity score ${hit.score}`,
            });
            report.archived.push(entry.id);
          } catch (err) {
            console.error(`[hygiene] merge ${other.id} <- ${entry.id} failed:`, err);
          }
          // `entry` is now the loser — abandon its remaining hits and skip the
          // final survivor write (its content already lives in `other`).
          absorbedAny = false;
          break;
        }

        // `entry` survives; absorb `other` CUMULATIVELY into the accumulators.
        try {
          foldedContent = foldInto(foldedContent, other.content);
          foldedTags = unionTags(foldedTags, other.tags);
          // Archive the absorbed entry (tag only — never hard-delete).
          await updateEntry(other.id, { tags: unionTags(other.tags, [ARCHIVED_TAG]) });
          archivedThisPass.add(other.id);
          absorbedAny = true;
          report.merged.push({
            survivorId: entry.id,
            absorbedId: other.id,
            reason: `near-duplicate, similarity score ${hit.score}`,
          });
          report.archived.push(other.id);
        } catch (err) {
          // One bad merge must not abort the pass.
          console.error(`[hygiene] merge ${entry.id} <- ${other.id} failed:`, err);
        }
      }

      // Single write of the cumulatively-folded survivor — every absorbed
      // loser's content+tags are present (F1: no clobber). OMIT recallCount /
      // lastRecalledAt so the survivor keeps its (higher) recall metadata.
      if (absorbedAny) {
        try {
          await updateEntry(entry.id, { content: foldedContent, tags: foldedTags });
        } catch (err) {
          console.error(`[hygiene] survivor patch ${entry.id} failed:`, err);
        }
      }
    } catch (err) {
      console.error(`[hygiene] dedup search for ${entry.id} failed:`, err);
    }
  }

  // ── (b) Flag + archive cold entries ────────────────────────────────────
  for (const entry of entries) {
    // Skip anything already archived this pass (merge-absorbed) or pre-archived
    // on input — a merged-away entry must not also be flagged cold.
    if (archivedThisPass.has(entry.id)) continue;

    try {
      const createdMs = Date.parse(entry.createdAt);
      // Only entries past the grace window are eligible (a brand-new entry that
      // simply hasn't been recalled yet is NOT cold).
      const pastGrace = Number.isFinite(createdMs) && nowMs - createdMs > graceDays * DAY_MS;
      if (!pastGrace) continue;

      const rarelyRecalled = entry.recallCount <= coldRecallMax;
      if (!rarelyRecalled) continue;

      const recalledMs = entry.lastRecalledAt ? Date.parse(entry.lastRecalledAt) : null;
      const staleRecall =
        recalledMs === null ||
        !Number.isFinite(recalledMs) ||
        nowMs - recalledMs > coldRecallAgeDays * DAY_MS;
      if (!staleRecall) continue;

      report.decayCandidates.push(entry.id);
      try {
        await updateEntry(entry.id, { tags: unionTags(entry.tags, [ARCHIVED_TAG]) });
        report.archived.push(entry.id);
      } catch (err) {
        console.error(`[hygiene] archive cold ${entry.id} failed:`, err);
      }
    } catch (err) {
      console.error(`[hygiene] cold check for ${entry.id} failed:`, err);
    }
  }

  return report;
}
