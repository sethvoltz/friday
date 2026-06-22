/**
 * FRI-26 Memory Dreaming — the apply pipeline (design D6 / addendum R3).
 *
 * `/api/evolve/scan` runs the usual signal → propose → rerank flow, then hands
 * the dream-shaped proposals (those whose signals carry a decodable
 * `DreamPayload`) to `applyDreamProposals`. For each dream proposal this:
 *
 *   1. recovers the memory category from the decoded payload;
 *   2. dedups against the live corpus via `searchMemories({ query: title })` —
 *      a top hit clearing `DREAM_DEDUP_MIN_SCORE` (and not a memory we already
 *      promoted earlier this same run) means the candidate is already covered,
 *      so we EXTEND that entry via `updateEntry` (folding content + unioning
 *      tags, OMITTING recallCount/lastRecalledAt so the survivor keeps its
 *      recall metadata) → recorded as `reinforced` (AC4);
 *   3. otherwise gates auto-write on the per-category threshold
 *      (`CATEGORY_AUTOAPPLY_THRESHOLD[category]`, person highest at 80) — a
 *      proposal at/above its bar is auto-applied via `applyProposal` (which
 *      writes the `memory_entries` row tagged `["evolve", ...appliesTo]`, where
 *      `appliesTo` already carries `memory:dreaming` + the category from the
 *      dream branch of `draftFromSignal`) → recorded as `promoted` (AC3, AC7b);
 *   4. otherwise leaves the proposal `open` (it surfaces for human review via
 *      evolve_list) and records its id in `openBelowThreshold` (AC5, AC7a) —
 *      writing NOTHING to memory.
 *
 * Preserve-over-delete is absolute: this module NEVER hard-deletes a memory
 * (AC10 statically asserts the hard-delete primitive is absent from this
 * source). Each per-proposal step is wrapped in its own try/catch + warn-log so
 * one bad proposal cannot abort the batch (R7).
 *
 * The IO boundary (`searchMemories`/`updateEntry`/`applyProposal`/
 * `updateProposal`) is injectable via `deps` for unit tests; the endpoint passes
 * the REAL imports (CLAUDE.md: mock the IO boundary, not the function under
 * test).
 */

import {
  searchMemories as realSearchMemories,
  updateEntry as realUpdateEntry,
} from "@friday/memory";
import { applyProposal as realApplyProposal, slugify } from "./apply.js";
import { updateProposal as realUpdateProposal } from "./store.js";
import { decodeDreamPayload } from "./scan-dreaming.js";
import {
  CATEGORY_AUTOAPPLY_THRESHOLD,
  DREAM_DEDUP_MIN_SCORE,
  type DreamCategory,
} from "./dreaming-thresholds.js";
import type { DreamDiaryItem } from "./dream-diary.js";
import type { Proposal } from "./types.js";

/**
 * The IO boundary `applyDreamProposals` depends on. Defaults are the REAL
 * `@friday/memory` + `./apply.js` + `./store.js` imports; tests inject in-memory
 * fakes/spies (mirroring propose.test.ts's mocked store).
 */
export interface DreamApplyDeps {
  searchMemories: typeof realSearchMemories;
  updateEntry: typeof realUpdateEntry;
  applyProposal: typeof realApplyProposal;
  /** Patch a proposal's `appliesTo` (or other fields) if the apply path ever
   *  needs to correct it; `draftFromSignal` already lands the dream `appliesTo`,
   *  so the default flow does not call this. */
  updateProposal: typeof realUpdateProposal;
}

const DEFAULT_DEPS: DreamApplyDeps = {
  searchMemories: realSearchMemories,
  updateEntry: realUpdateEntry,
  applyProposal: realApplyProposal,
  updateProposal: realUpdateProposal,
};

export interface DreamApplyResult {
  /** Proposals auto-applied this run (new memory_entries rows). */
  promoted: DreamDiaryItem[];
  /** Existing memories EXTENDED instead of duplicated (dedup hit). */
  reinforced: DreamDiaryItem[];
  /** Proposal ids left `open` because they did not clear their category bar
   *  (deferred for human review — NOT an error). */
  openBelowThreshold: string[];
  /** Proposal ids that CLEARED their threshold but whose `applyProposal` call
   *  returned `ok:false` — a genuine apply failure, distinct from a deliberate
   *  below-threshold deferral. G5 surfaces these as a `warn` log. */
  failed: string[];
}

/** Union two tag lists, dropping duplicates, preserving first-seen order. */
function unionTags(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/** Fold the proposed content onto the existing entry's, separated by a rule.
 *  Mirrors hygiene.ts's `foldContent` shape so reinforced memories read
 *  consistently. */
function foldContent(existing: string, addition: string): string {
  return [existing.trim(), "", "---", "", addition.trim()].join("\n");
}

/**
 * Apply the dream-shaped proposals produced by a scan run. Each proposal is
 * one of: extended (dedup hit → reinforced), auto-applied (cleared its
 * category threshold → promoted), or left open (below threshold).
 *
 * @param dreamProposals proposals whose signals carry a decodable DreamPayload
 *   (`proposal.signals.some(s => decodeDreamPayload(s))`).
 * @param callerName the scan caller (e.g. `scheduled-meta-daily`) — becomes the
 *   applied memory's `createdBy`.
 * @param deps IO boundary; defaults to the real memory/apply/store imports.
 */
export async function applyDreamProposals(
  dreamProposals: Proposal[],
  callerName: string,
  deps?: Partial<DreamApplyDeps>,
): Promise<DreamApplyResult> {
  const d: DreamApplyDeps = { ...DEFAULT_DEPS, ...deps };
  const result: DreamApplyResult = {
    promoted: [],
    reinforced: [],
    openBelowThreshold: [],
    failed: [],
  };

  // Slugs promoted earlier in THIS run, so two candidates that collapse to the
  // same memory in one window dedup against each other (the first writes the
  // row, the second extends it rather than racing a duplicate).
  const promotedSlugs = new Set<string>();

  for (const proposal of dreamProposals) {
    try {
      const dreamSignal = proposal.signals.find((s) => decodeDreamPayload(s));
      const payload = dreamSignal ? decodeDreamPayload(dreamSignal) : null;
      if (!payload) continue; // not actually a dream proposal — skip defensively.
      const category: Exclude<DreamCategory, "none"> = payload.category;

      const slug = slugify(proposal.title);

      // ── Dedup: extend an existing memory instead of duplicating it ────────
      let dedupHit: { id: string; tags: string[]; content: string; score: number } | null = null;
      try {
        const hits = await d.searchMemories({ query: proposal.title, limit: 5 });
        const top = hits[0];
        if (top && top.score >= DREAM_DEDUP_MIN_SCORE) {
          dedupHit = {
            id: top.entry.id,
            tags: top.entry.tags,
            content: top.entry.content,
            score: top.score,
          };
        }
      } catch (err) {
        console.error(`[dreaming] dedup search for ${proposal.id} failed:`, err);
      }

      if (dedupHit && !promotedSlugs.has(slug)) {
        // EXTEND — fold the proposed content in, union the proposed tags.
        // OMIT recallCount/lastRecalledAt so the survivor keeps its recall
        // metadata (updateEntry spreads `...cur, ...patch`).
        await d.updateEntry(dedupHit.id, {
          content: foldContent(dedupHit.content, payload.content),
          tags: unionTags(dedupHit.tags, ["memory:dreaming", category, ...payload.tags]),
        });
        result.reinforced.push({
          action: "reinforced",
          title: proposal.title,
          score: proposal.score,
          evidence: `extended existing memory '${dedupHit.id}' (search score ${dedupHit.score})`,
        });
        continue;
      }

      // ── Auto-apply gate (per-category threshold) ─────────────────────────
      const threshold = CATEGORY_AUTOAPPLY_THRESHOLD[category];
      if (proposal.score >= threshold) {
        const outcome = await d.applyProposal(proposal.id, { appliedBy: callerName });
        if (outcome.ok) {
          promotedSlugs.add(slug);
          result.promoted.push({
            action: "promoted",
            title: proposal.title,
            score: proposal.score,
            evidence: `${category} ≥ ${threshold} → auto-applied as ${outcome.appliedRef}`,
          });
        } else {
          // Cleared its threshold but the apply call failed — a genuine error,
          // NOT a below-threshold deferral. Surface it as `failed` (warn-log)
          // so it is not silently misfiled as "open for human review".
          console.warn(`[dreaming] applyProposal ${proposal.id} failed: ${outcome.reason}`);
          result.failed.push(proposal.id);
        }
        continue;
      }

      // ── Below threshold: leave open for human review. Write nothing. ─────
      result.openBelowThreshold.push(proposal.id);
    } catch (err) {
      console.error(`[dreaming] applying proposal ${proposal.id} failed:`, err);
    }
  }

  return result;
}
