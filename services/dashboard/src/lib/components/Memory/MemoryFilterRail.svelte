<script lang="ts">
  // FRI-172 — the grouped faceted rail: All / CATEGORIES / freeform TAGS /
  // Archived. PURE presentation + upward callbacks: it holds NO selection
  // state, reads the parent-owned `state`/`counts`, and emits toggles via
  // callback props. Data-driven (AC6b): a CATEGORY/Archived facet renders only
  // at count ≥ 1 — no dead `(0)` chips. The freeform TAGS region scrolls
  // independently (AC20); All + CATEGORIES stay pinned above it.
  import {
    CATEGORIES,
    type FacetState,
    type FacetCounts,
  } from "./facet-filter";

  interface Props {
    /** Current selection — owned by MemoryPage. */
    state: FacetState;
    /** Per-category/tag/archived counts for data-driven rendering. */
    counts: FacetCounts;
    /** Count of non-archived entries (the `All (n)` chip). */
    allCount: number;
    /** Toggle a category in selectedCategories. */
    ontogglecategory?: (category: string) => void;
    /** Toggle a freeform tag in selectedTags. */
    ontoggletag?: (tag: string) => void;
    /** Toggle archivedOnly. */
    ontogglearchived?: () => void;
    /** Reset to All (clear categories, tags, archivedOnly). */
    onclearall?: () => void;
  }

  let {
    state,
    counts,
    allCount,
    ontogglecategory,
    ontoggletag,
    ontogglearchived,
    onclearall,
  }: Props = $props();

  // Categories that actually have ≥1 visible entry, in the canonical CATEGORIES
  // order (data-driven — AC6b). `person (0)` simply never appears.
  const visibleCategories = $derived(
    CATEGORIES.filter((c) => (counts.categories[c] ?? 0) >= 1),
  );

  // Freeform tags, frequency-sorted desc then alpha for a stable order. Every
  // key in `counts.tags` is ≥1 by construction.
  const sortedTags = $derived(
    Object.entries(counts.tags).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    }),
  );

  // `All` is the active state when nothing is selected and we're not in the
  // archived view.
  const allActive = $derived(
    state.selectedCategories.size === 0 &&
      state.selectedTags.size === 0 &&
      !state.archivedOnly,
  );
</script>

<nav class="filter-rail" aria-label="Memory filters">
  <!-- Pinned: All + CATEGORIES. -->
  <div class="rail-pinned">
    <div class="rail-group">
      <button
        type="button"
        class="chip"
        class:selected={allActive}
        onclick={() => onclearall?.()}>
        All <span class="chip-count">({allCount})</span>
      </button>
    </div>

    {#if visibleCategories.length > 0}
      <div class="rail-group">
        <span class="group-label">Categories</span>
        <div class="chip-list">
          {#each visibleCategories as cat (cat)}
            <button
              type="button"
              class="chip"
              class:selected={state.selectedCategories.has(cat)}
              aria-pressed={state.selectedCategories.has(cat)}
              onclick={() => ontogglecategory?.(cat)}>
              {cat} <span class="chip-count">({counts.categories[cat]})</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <!-- Scrollable freeform TAGS region (AC20). -->
  {#if sortedTags.length > 0}
    <div class="rail-group rail-tags">
      <span class="group-label">Tags</span>
      <div class="chip-list tag-scroll">
        {#each sortedTags as [tag, count] (tag)}
          <button
            type="button"
            class="chip"
            class:selected={state.selectedTags.has(tag)}
            aria-pressed={state.selectedTags.has(tag)}
            onclick={() => ontoggletag?.(tag)}>
            #{tag} <span class="chip-count">({count})</span>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Pinned bottom: Archived (only when ≥1, AC6b). -->
  {#if counts.archived >= 1}
    <div class="rail-group rail-archived">
      <button
        type="button"
        class="chip"
        class:selected={state.archivedOnly}
        aria-pressed={state.archivedOnly}
        onclick={() => ontogglearchived?.()}>
        Archived <span class="chip-count">({counts.archived})</span>
      </button>
    </div>
  {/if}
</nav>

<style>
  .filter-rail {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    /* Fill the rail column so the tag region can claim the leftover height for
       its own scroll. */
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
  }
  .rail-pinned {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .rail-group {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .group-label {
    color: var(--text-tertiary);
    text-transform: uppercase;
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  /* The TAGS list owns its OWN scroll (AC20) — All + CATEGORIES stay pinned
     above; a long freeform tag list scrolls here without moving the page. */
  .rail-tags {
    flex: 1;
    min-height: 0;
  }
  .tag-scroll {
    overflow-y: auto;
    min-height: 0;
    max-height: 100%;
    /* A bounded fallback height for the mobile sheet, where the rail isn't in a
       fixed-height grid column. */
    max-height: 16rem;
    padding-right: 0.15rem;
    align-content: flex-start;
  }
  .rail-archived {
    flex-shrink: 0;
    border-top: 1px solid var(--border-subtle);
    padding-top: 0.55rem;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    /* Compact, dense facets per owner feedback. The AC21 44px tap-target floor
       stays where the e2e asserts it — the mobile active-filter chips + Filters
       button in MemoryPage — not on these high-density rail facets. */
    min-height: 28px;
    padding: 0.2rem 0.55rem;
    border-radius: 7px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 0.78rem;
    font-family: var(--font-mono);
    cursor: pointer;
    touch-action: manipulation;
    transition: background var(--transition-fast),
      border-color var(--transition-fast), color var(--transition-fast);
  }
  .chip:hover {
    color: var(--text-primary);
    border-color: var(--border-primary);
  }
  .chip:focus-visible {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 1px var(--accent-glow);
  }
  .chip.selected {
    background: var(--accent-glow);
    border-color: var(--accent-primary);
    color: var(--text-primary);
  }
  .chip-count {
    color: var(--text-tertiary);
    font-size: 0.65rem;
  }
</style>
