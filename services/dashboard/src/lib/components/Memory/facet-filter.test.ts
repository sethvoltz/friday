import { describe, it, expect } from "vitest";
import {
  matchesFacets,
  allCount,
  facetCounts,
  sortComparators,
  type MemoryView,
  type FacetState,
} from "./facet-filter";

// Hand-built MemoryView factory — only the fields a given assertion exercises
// need to be set; the rest get cheap deterministic defaults. `tags` and the
// sort keys (id/title/updatedAt/recallCount) are the load-bearing inputs.
function mk(over: Partial<MemoryView> & { id: string }): MemoryView {
  return {
    id: over.id,
    title: over.title ?? over.id,
    content: over.content ?? "",
    tags: over.tags ?? [],
    createdBy: over.createdBy ?? "user",
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-01-01T00:00:00.000Z",
    recallCount: over.recallCount ?? 0,
    lastRecalledAt: over.lastRecalledAt ?? null,
  };
}

function state(over: Partial<FacetState> = {}): FacetState {
  return {
    selectedCategories: over.selectedCategories ?? new Set(),
    selectedTags: over.selectedTags ?? new Set(),
    archivedOnly: over.archivedOnly ?? false,
  };
}

// ── AC5: matchesFacets truth-table ───────────────────────────────────────
describe("matchesFacets — AC5 facet semantics", () => {
  it("categories are OR within the group (user OR feedback)", () => {
    const sel = state({ selectedCategories: new Set(["user", "feedback"]) });
    // matches on user alone
    expect(matchesFacets(mk({ id: "a", tags: ["user"] }), sel)).toBe(true);
    // matches on feedback alone
    expect(matchesFacets(mk({ id: "b", tags: ["feedback"] }), sel)).toBe(true);
    // matches when it carries both
    expect(matchesFacets(mk({ id: "c", tags: ["user", "feedback"] }), sel)).toBe(true);
    // no overlap with either selected category → excluded
    expect(matchesFacets(mk({ id: "d", tags: ["project"] }), sel)).toBe(false);
    // a bare entry (no tags) → excluded
    expect(matchesFacets(mk({ id: "e", tags: [] }), sel)).toBe(false);
  });

  it("tags are AND within the group (release AND ci)", () => {
    const sel = state({ selectedTags: new Set(["release", "ci"]) });
    // both present → match
    expect(matchesFacets(mk({ id: "a", tags: ["release", "ci"] }), sel)).toBe(true);
    // only one present → excluded (AND, not OR)
    expect(matchesFacets(mk({ id: "b", tags: ["release"] }), sel)).toBe(false);
    expect(matchesFacets(mk({ id: "c", tags: ["ci"] }), sel)).toBe(false);
    // neither present → excluded
    expect(matchesFacets(mk({ id: "d", tags: ["other"] }), sel)).toBe(false);
  });

  it("category group AND-combines with the tag group (feedback AND ci)", () => {
    const sel = state({
      selectedCategories: new Set(["feedback"]),
      selectedTags: new Set(["ci"]),
    });
    // satisfies both groups
    expect(matchesFacets(mk({ id: "a", tags: ["feedback", "ci"] }), sel)).toBe(true);
    // category but no tag → excluded
    expect(matchesFacets(mk({ id: "b", tags: ["feedback"] }), sel)).toBe(false);
    // tag but no category → excluded
    expect(matchesFacets(mk({ id: "c", tags: ["ci"] }), sel)).toBe(false);
  });

  it("archivedOnly=false EXCLUDES archived entries", () => {
    const sel = state({ archivedOnly: false });
    expect(matchesFacets(mk({ id: "a", tags: ["user"] }), sel)).toBe(true);
    expect(matchesFacets(mk({ id: "b", tags: ["user", "archived"] }), sel)).toBe(false);
    expect(matchesFacets(mk({ id: "c", tags: ["archived"] }), sel)).toBe(false);
  });

  it("archivedOnly=true INCLUDES only archived entries", () => {
    const sel = state({ archivedOnly: true });
    expect(matchesFacets(mk({ id: "a", tags: ["user", "archived"] }), sel)).toBe(true);
    expect(matchesFacets(mk({ id: "b", tags: ["archived"] }), sel)).toBe(true);
    // non-archived excluded under the archived-only gate
    expect(matchesFacets(mk({ id: "c", tags: ["user"] }), sel)).toBe(false);
    expect(matchesFacets(mk({ id: "d", tags: [] }), sel)).toBe(false);
  });

  it("archived gate composes with categories — archivedOnly=true + category filter", () => {
    const sel = state({
      selectedCategories: new Set(["user"]),
      archivedOnly: true,
    });
    // archived AND in the selected category → match
    expect(matchesFacets(mk({ id: "a", tags: ["user", "archived"] }), sel)).toBe(true);
    // archived but wrong category → excluded
    expect(matchesFacets(mk({ id: "b", tags: ["project", "archived"] }), sel)).toBe(false);
    // right category but not archived → excluded
    expect(matchesFacets(mk({ id: "c", tags: ["user"] }), sel)).toBe(false);
  });

  it("empty FacetState (no selection, archivedOnly=false) matches all non-archived", () => {
    const sel = state();
    expect(matchesFacets(mk({ id: "a", tags: [] }), sel)).toBe(true);
    expect(matchesFacets(mk({ id: "b", tags: ["user", "ci"] }), sel)).toBe(true);
    expect(matchesFacets(mk({ id: "c", tags: ["archived"] }), sel)).toBe(false);
  });
});

// ── AC6: allCount + facetCounts data-driven counts ───────────────────────
describe("allCount — AC6 non-archived total", () => {
  // 10 entries, 3 carrying the "archived" tag → allCount === 7.
  const ten: MemoryView[] = [
    mk({ id: "m01", tags: ["user"] }),
    mk({ id: "m02", tags: ["feedback"] }),
    mk({ id: "m03", tags: ["project", "archived"] }), // archived
    mk({ id: "m04", tags: ["reference"] }),
    mk({ id: "m05", tags: ["archived"] }), // archived
    mk({ id: "m06", tags: ["pinned"] }),
    mk({ id: "m07", tags: ["user", "ci"] }),
    mk({ id: "m08", tags: ["feedback", "archived"] }), // archived
    mk({ id: "m09", tags: ["reference", "release"] }),
    mk({ id: "m10", tags: [] }),
  ];

  it("counts only entries NOT tagged 'archived' (10 entries, 3 archived → 7)", () => {
    expect(allCount(ten)).toBe(7);
  });

  it("returns 0 for an empty set", () => {
    expect(allCount([])).toBe(0);
  });
});

describe("facetCounts — AC6b data-driven facets", () => {
  // categories + freeform tags counted over the NON-archived set;
  // archived counted over the FULL set.
  const corpus: MemoryView[] = [
    mk({ id: "c1", tags: ["user", "release"] }),
    mk({ id: "c2", tags: ["user", "ci"] }),
    mk({ id: "c3", tags: ["feedback", "release"] }),
    mk({ id: "c4", tags: ["project", "archived"] }), // archived → not counted in cats/tags
    mk({ id: "c5", tags: ["archived", "release"] }), // archived → release here NOT counted
    mk({ id: "c6", tags: ["reference"] }),
  ];
  const counts = facetCounts(corpus);

  it("categories: only ≥1-hit CATEGORIES keys, counted over the non-archived set", () => {
    expect(counts.categories).toEqual({ user: 2, feedback: 1, reference: 1 });
    // 'project' only appears on an archived entry → absent (not 0-keyed in non-archived set)
    expect(counts.categories.project).toBeUndefined();
    // categories never present → absent
    expect(counts.categories.pinned).toBeUndefined();
    expect(counts.categories.person).toBeUndefined();
  });

  it("tags: only freeform tags (∉ CATEGORIES, ≠ 'archived') with ≥1 hit, non-archived only", () => {
    // release on c1,c3 counts (2); release on archived c5 does NOT.
    expect(counts.tags).toEqual({ release: 2, ci: 1 });
    // 'archived' is never a freeform tag key
    expect(counts.tags.archived).toBeUndefined();
    // category names never leak into freeform tags
    expect(counts.tags.user).toBeUndefined();
  });

  it("archived: counted over the FULL set", () => {
    expect(counts.archived).toBe(2);
  });

  it("dedups repeated tags within a single entry (no double-count)", () => {
    const dup = facetCounts([mk({ id: "d1", tags: ["user", "user", "ci", "ci"] })]);
    expect(dup.categories).toEqual({ user: 1 });
    expect(dup.tags).toEqual({ ci: 1 });
  });

  it("empty corpus → empty maps and zero archived", () => {
    expect(facetCounts([])).toEqual({ categories: {}, tags: {}, archived: 0 });
  });
});

// ── AC8: sort comparators — exact pinned id arrays, ≥1 tie each ───────────
describe("sortComparators — AC8 deterministic ordering", () => {
  it("recency: updatedAt desc, ties → id asc; returns a new array", () => {
    const input: MemoryView[] = [
      mk({ id: "r-b", updatedAt: "2026-03-01T00:00:00.000Z" }),
      mk({ id: "r-a", updatedAt: "2026-03-01T00:00:00.000Z" }), // tie with r-b on updatedAt
      mk({ id: "r-c", updatedAt: "2026-05-01T00:00:00.000Z" }), // newest
      mk({ id: "r-d", updatedAt: "2026-01-01T00:00:00.000Z" }), // oldest
    ];
    const out = sortComparators.recency(input);
    // newest first; the updatedAt tie (r-a/r-b) breaks by id asc → r-a before r-b
    expect(out.map((e) => e.id)).toEqual(["r-c", "r-a", "r-b", "r-d"]);
    // does not mutate the input array
    expect(input.map((e) => e.id)).toEqual(["r-b", "r-a", "r-c", "r-d"]);
    expect(out).not.toBe(input);
  });

  it("recalled: recallCount desc, ties → updatedAt desc, then id asc", () => {
    const input: MemoryView[] = [
      mk({ id: "x-a", recallCount: 5, updatedAt: "2026-02-01T00:00:00.000Z" }),
      // tie with x-a on recallCount=5; newer updatedAt → ranks ahead of x-a
      mk({ id: "x-b", recallCount: 5, updatedAt: "2026-04-01T00:00:00.000Z" }),
      // full tie with x-d on both recallCount=2 AND updatedAt → id asc breaks it
      mk({ id: "x-e", recallCount: 2, updatedAt: "2026-01-01T00:00:00.000Z" }),
      mk({ id: "x-d", recallCount: 2, updatedAt: "2026-01-01T00:00:00.000Z" }),
      mk({ id: "x-c", recallCount: 9, updatedAt: "2026-01-01T00:00:00.000Z" }), // highest
    ];
    const out = sortComparators.recalled(input);
    // 9 → (5: newer-updated x-b, then x-a) → (2: id-asc x-d, then x-e)
    expect(out.map((e) => e.id)).toEqual(["x-c", "x-b", "x-a", "x-d", "x-e"]);
    expect(out).not.toBe(input);
  });

  it("alpha: title localeCompare asc, ties → id asc", () => {
    const input: MemoryView[] = [
      mk({ id: "a-2", title: "Banana" }),
      mk({ id: "a-1", title: "Banana" }), // title tie with a-2 → id asc wins
      mk({ id: "a-3", title: "Apple" }),
      mk({ id: "a-4", title: "cherry" }), // lowercase — localeCompare orders after Banana
    ];
    const out = sortComparators.alpha(input);
    expect(out.map((e) => e.id)).toEqual(["a-3", "a-1", "a-2", "a-4"]);
    expect(out).not.toBe(input);
  });
});
