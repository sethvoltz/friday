/**
 * Priority+ header overflow math (extracted from `+layout.svelte` so it can be
 * unit-tested in isolation). See `docs/mobile-ux.md` — links live in
 * `.header-right` and overflow ONE AT A TIME into a `More` menu as the header
 * narrows; the visible count is a pure, monotonic function of the measured
 * available width.
 *
 * The regression this guards against (FRI-171): a non-link item added to the
 * `.header-right` cluster (the Inbox bell, the ⌘K chip, …) consumes width that
 * the budget MUST subtract. Forgetting one makes the math believe a link fits
 * when it physically doesn't, so the link overflows the container and clips
 * instead of moving into `More`. Every always-present cluster item's width is
 * passed in `clusterReserves`.
 */

export interface VisibleCountInput {
  /** `.header-right` content width (the overflow-invariant flex leftover). */
  availWidth: number;
  /** Per-link intrinsic widths, ghost-measured, in `navLinks` order. */
  linkWidths: number[];
  /** Number of nav links (== `linkWidths.length` once measured). */
  navCount: number;
  /** Intrinsic width of the `More` button (ghost-measured). */
  moreWidth: number;
  /** Gap between adjacent links. */
  navGap: number;
  /** Gap between `.header-right` cluster items (nav ↔ bell ↔ ⌘K ↔ More). */
  clusterGap: number;
  /**
   * Widths of the always-present, non-link cluster items sharing `.header-right`
   * (e.g. the Inbox bell, the ⌘K chip). A `0` entry (item hidden/unmeasured) is
   * skipped; each non-zero entry costs `width + clusterGap`.
   */
  clusterReserves: number[];
}

/**
 * How many links fit before overflowing into `More`. Pure function of the
 * measured widths → no resize feedback loop.
 */
export function computeVisibleCount(input: VisibleCountInput): number {
  const { availWidth, linkWidths, navCount, moreWidth, navGap, clusterGap, clusterReserves } =
    input;

  // Not measured yet → show everything (the ghost fills widths on first paint).
  if (availWidth === 0 || linkWidths.length !== navCount) return navCount;

  // Reserve every always-present non-link cluster item (bell, ⌘K, …).
  const reserve = clusterReserves.reduce((sum, w) => sum + (w > 0 ? w + clusterGap : 0), 0);
  const budget = availWidth - reserve;

  // Everything fits with no More button? Show it all (no More reserve needed).
  let sumAll = 0;
  for (let i = 0; i < navCount; i++) {
    sumAll += linkWidths[i] + (i > 0 ? navGap : 0);
  }
  if (sumAll <= budget) return navCount;

  // Otherwise a More button is guaranteed — permanently reserve its width and
  // greedily fit links to its left. Reserving unconditionally is what keeps the
  // 0↔1 overflow boundary from oscillating.
  const moreCost = moreWidth + clusterGap;
  let used = 0;
  for (let i = 0; i < navCount; i++) {
    const cost = linkWidths[i] + (i > 0 ? navGap : 0);
    if (used + cost + moreCost > budget) return i;
    used += cost;
  }
  return navCount;
}
