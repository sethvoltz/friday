// FRI-172 — Pure faceted-filter / sort logic for the Memories page redesign.
//
// DOM-free + Svelte-free by construction so it can be unit-tested directly
// against hand-built `MemoryView` objects (see facet-filter.test.ts). Every
// Memory component imports `MemoryView` (and the facet/sort surface) from
// HERE — single source of truth, keeps two aliases from drifting.
//
// `MemoryView` is structurally identical to `MemoryEntry` from
// `@friday/memory` (see packages/memory/src/store.ts) — the Memory
// components standardize on the `MemoryView` name; the Zero → MemoryView
// mapping lives in MemoryPage.svelte.

export interface MemoryView {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdBy: string;
  /** ISO-8601 string. */
  createdAt: string;
  /** ISO-8601 string. Recency sort key. */
  updatedAt: string;
  recallCount: number;
  lastRecalledAt: string | null;
}

/**
 * The fixed category tags. A tag in this set is a CATEGORY facet (rendered in
 * the rail's CATEGORIES group); any other non-"archived" tag is a freeform
 * TAG facet.
 */
export const CATEGORIES = ["user", "feedback", "project", "reference", "person", "pinned"] as const;

/** The tag that, when present, marks an entry as archived. */
export const ARCHIVED_TAG = "archived";

export type SortKey = "recency" | "recalled" | "alpha";

export interface FacetState {
  /** ⊆ CATEGORIES. */
  selectedCategories: Set<string>;
  /** Freeform tags (NOT categories, NOT "archived"). */
  selectedTags: Set<string>;
  archivedOnly: boolean;
}

export interface FacetCounts {
  /** Count per category value (only meaningful keys; 0 allowed). */
  categories: Record<string, number>;
  /** Count per freeform tag (excludes CATEGORIES + ARCHIVED_TAG; only count≥1 keys present). */
  tags: Record<string, number>;
  /** Count of entries carrying ARCHIVED_TAG. */
  archived: number;
}

const CATEGORY_SET: ReadonlySet<string> = new Set(CATEGORIES);

/** A freeform tag is any tag that is neither a category nor the archived tag. */
function isFreeformTag(tag: string): boolean {
  return tag !== ARCHIVED_TAG && !CATEGORY_SET.has(tag);
}

/**
 * AC5 §5c semantics. An entry matches iff ALL hold:
 *  1. Archived gate: archivedOnly=false → entry must NOT include "archived";
 *     archivedOnly=true → entry MUST include "archived".
 *  2. Categories (OR within group): if selectedCategories non-empty → entry
 *     must include ≥1 selected category tag.
 *  3. Tags (AND within group): if selectedTags non-empty → entry must include
 *     EVERY selected freeform tag.
 *  4. Groups combine with AND.
 */
export function matchesFacets(entry: MemoryView, state: FacetState): boolean {
  const tags = entry.tags;
  const isArchived = tags.includes(ARCHIVED_TAG);

  // 1. Archived gate.
  if (state.archivedOnly) {
    if (!isArchived) return false;
  } else {
    if (isArchived) return false;
  }

  // 2. Categories — OR within the group.
  if (state.selectedCategories.size > 0) {
    let any = false;
    for (const cat of state.selectedCategories) {
      if (tags.includes(cat)) {
        any = true;
        break;
      }
    }
    if (!any) return false;
  }

  // 3. Tags — AND within the group.
  if (state.selectedTags.size > 0) {
    for (const tag of state.selectedTags) {
      if (!tags.includes(tag)) return false;
    }
  }

  return true;
}

/**
 * Count of entries NOT tagged "archived" (the `All (n)` chip).
 * AC6: fixture of 10 (3 archived) → 7.
 */
export function allCount(entries: MemoryView[]): number {
  let n = 0;
  for (const e of entries) {
    if (!e.tags.includes(ARCHIVED_TAG)) n++;
  }
  return n;
}

/**
 * Data-driven facet counts (AC6b).
 *  - `categories`: only CATEGORIES keys with ≥1 hit, counted over the
 *    NON-archived set (so a category only renders for visible entries).
 *  - `tags`: only freeform tags (∉ CATEGORIES, ≠ "archived") with ≥1 hit,
 *    counted over the NON-archived set.
 *  - `archived`: count of "archived"-tagged entries over the FULL set.
 */
export function facetCounts(entries: MemoryView[]): FacetCounts {
  const categories: Record<string, number> = {};
  const tags: Record<string, number> = {};
  let archived = 0;

  for (const e of entries) {
    const isArchived = e.tags.includes(ARCHIVED_TAG);
    if (isArchived) archived++;

    // categories/tags are counted over the visible (non-archived) set only.
    if (isArchived) continue;

    // Dedup within an entry so duplicate tags don't double-count.
    const seen = new Set<string>();
    for (const tag of e.tags) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      if (CATEGORY_SET.has(tag)) {
        categories[tag] = (categories[tag] ?? 0) + 1;
      } else if (isFreeformTag(tag)) {
        tags[tag] = (tags[tag] ?? 0) + 1;
      }
    }
  }

  return { categories, tags, archived };
}

/**
 * Sort comparators — each sorts the FILTERED set BEFORE slicing.
 * Each returns a NEW array (does not mutate input). Tie-breaks pinned below.
 *  - recency:  updatedAt desc, ties → id asc
 *  - recalled: recallCount desc, ties → updatedAt desc, then id asc
 *  - alpha:    title localeCompare asc, ties → id asc
 */
export const sortComparators: Record<SortKey, (entries: MemoryView[]) => MemoryView[]> = {
  recency: (entries) =>
    [...entries].sort((a, b) => {
      const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
      if (byUpdated !== 0) return byUpdated;
      return a.id.localeCompare(b.id);
    }),
  recalled: (entries) =>
    [...entries].sort((a, b) => {
      const byCount = b.recallCount - a.recallCount;
      if (byCount !== 0) return byCount;
      const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
      if (byUpdated !== 0) return byUpdated;
      return a.id.localeCompare(b.id);
    }),
  alpha: (entries) =>
    [...entries].sort((a, b) => {
      const byTitle = a.title.localeCompare(b.title);
      if (byTitle !== 0) return byTitle;
      return a.id.localeCompare(b.id);
    }),
};
