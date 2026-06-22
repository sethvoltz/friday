<script lang="ts">
  // FRI-172 — the main pane: header (counts + sort <select> + `+ New`), an
  // infinite-scroll list of MemoryCards, an optional blank create-editor
  // accordion at the top, and the project-standard `.empty-state` zero-state.
  //
  // Infinite scroll is owned HERE (AC7): render `entries.slice(0, limit)`, an
  // IntersectionObserver on a bottom sentinel bumps `limit` by 50. Reveal-to-
  // open (AC11): an $effect bumps `limit` past `openId`'s index so a deep-linked
  // card mounts even when it sorts beyond the first page.
  import MemoryCard from "./MemoryCard.svelte";
  import MemoryEditor from "./MemoryEditor.svelte";
  import type { MemoryView, SortKey } from "./facet-filter";

  interface Props {
    /** Filtered + sorted full set (parent applies facets+sort BEFORE passing). */
    entries: MemoryView[];
    /** Total count for the header `{shown} / {total}` denominator. */
    total: number;
    /** Current sort key. */
    sort: SortKey;
    /** Currently-open accordion id (null = none). */
    openId: string | null;
    /** Whether the blank create-editor accordion is open at the top. */
    creating: boolean;
    onsortchange?: (sort: SortKey) => void;
    onnew?: () => void;
    oncreate?: (data: {
      title: string;
      content: string;
      tags: string[];
    }) => void;
    oncancelnew?: () => void;
    ontoggle?: (id: string) => void;
    onsave?: (
      id: string,
      data: { title: string; content: string; tags: string[] },
    ) => void;
    ondelete?: (id: string) => void;
  }

  let {
    entries,
    total,
    sort,
    openId,
    creating,
    onsortchange,
    onnew,
    oncreate,
    oncancelnew,
    ontoggle,
    onsave,
    ondelete,
  }: Props = $props();

  const PAGE = 50;
  let limit = $state(PAGE);

  // Reset the window when the filtered/sorted set is replaced (filter or sort
  // change) so we don't keep a stale deep window across a different result set.
  let prevKey = "";
  $effect(() => {
    // A cheap identity key: length + first/last ids. Changing facets/sort
    // yields a new key → collapse back to the first page.
    const key = `${entries.length}:${entries[0]?.id ?? ""}:${
      entries[entries.length - 1]?.id ?? ""
    }`;
    if (key !== prevKey) {
      prevKey = key;
      limit = PAGE;
    }
  });

  // Reveal-to-open (AC11): if the open card sorts beyond the current window,
  // grow `limit` to include it (rounded up to the next PAGE multiple) so the
  // card mounts and can scroll itself into view.
  $effect(() => {
    if (!openId) return;
    const idx = entries.findIndex((e) => e.id === openId);
    if (idx >= 0 && idx >= limit) {
      limit = Math.ceil((idx + 1) / PAGE) * PAGE;
    }
  });

  const shownEntries = $derived(entries.slice(0, limit));
  const shownCount = $derived(Math.min(limit, entries.length));

  // IntersectionObserver bottom sentinel → reveal the next page while there's
  // more to show.
  let sentinelEl = $state<HTMLDivElement | undefined>();
  $effect(() => {
    if (typeof window === "undefined") return;
    const el = sentinelEl;
    if (!el) return;
    const io = new IntersectionObserver((items) => {
      for (const item of items) {
        if (item.isIntersecting && limit < entries.length) {
          limit = Math.min(limit + PAGE, entries.length);
        }
      }
    });
    io.observe(el);
    return () => io.disconnect();
  });

  function onSortSelect(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value as SortKey;
    onsortchange?.(v);
  }
</script>

<div class="memory-list">
  <div class="list-header">
    <span class="stat-detail" data-testid="memory-count">{shownCount} / {total}</span>
    <div class="header-controls">
      <label class="sort-label">
        <span class="sr-only">Sort</span>
        <select
          class="sort-select"
          value={sort}
          onchange={onSortSelect}
          aria-label="Sort memories">
          <option value="recency">Recency</option>
          <option value="recalled">Most recalled</option>
          <option value="alpha">A–Z</option>
        </select>
      </label>
      <button type="button" class="ghost primary new-btn" onclick={() => onnew?.()}>
        + New
      </button>
    </div>
  </div>

  {#if creating}
    <div class="create-accordion">
      <MemoryEditor
        mode="create"
        oncreate={(d) => oncreate?.(d)}
        oncancel={() => oncancelnew?.()} />
    </div>
  {/if}

  {#if entries.length === 0}
    <p class="empty-state">
      No memories match. Loosen the filters above or create one.
    </p>
  {:else}
    <ul class="cards">
      {#each shownEntries as entry (entry.id)}
        <MemoryCard
          entry={entry}
          open={openId === entry.id}
          ontoggle={(id) => ontoggle?.(id)}
          onsave={(id, d) => onsave?.(id, d)}
          ondelete={(id) => ondelete?.(id)} />
      {/each}
    </ul>
    <!-- Infinite-scroll sentinel (AC7). -->
    {#if limit < entries.length}
      <div class="sentinel" bind:this={sentinelEl} aria-hidden="true"></div>
    {/if}
  {/if}
</div>

<style>
  .memory-list {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  .list-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .stat-detail {
    color: var(--text-tertiary);
    font-size: 0.78rem;
    font-family: var(--font-mono);
  }
  .header-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .sort-label {
    display: inline-flex;
  }
  .sort-select {
    padding: 0.5rem 0.6rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.82rem;
    font-family: inherit;
    cursor: pointer;
  }
  .sort-select:focus-visible {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 1px var(--accent-glow);
  }
  button.primary {
    color: var(--accent-primary);
    border-color: var(--accent-primary);
  }
  .create-accordion {
    padding: 0.75rem;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
  }
  .cards {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .sentinel {
    height: 1px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>
