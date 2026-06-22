<script lang="ts">
  // FRI-172 — orchestrator for the redesigned Memories surface. Used by BOTH
  // route wrappers (/memory via $page.state.memoryId; /memory/[id] via
  // initialOpenId). Owns: entries (Zero $effect + SSR warm baseline + REST
  // fallback), FTS search (unchanged /api/memory/search + 250ms debounce),
  // FacetState, sort, the create accordion, and shallow routing. Mounts
  // <RailShell> with rail/main/topbar snippets.
  //
  // Boundary (AC1c): RailShell owns the breakpoint — this file calls NO
  // matchMedia. Warm transitions are shallow pushState/replaceState only —
  // NEVER goto (AC23).
  import type { SearchResult } from "@friday/memory";
  import { pushState } from "$app/navigation";
  import { page } from "$app/stores";
  import {
    useZero,
    zeroSync,
    type ZeroMemoryEntryRow,
  } from "$lib/stores/zero.svelte";
  import { slugifyMemoryId } from "@friday/shared/sync";
  import { confirmDialog } from "$lib/components/ConfirmDialog/store.svelte";
  import RailShell from "$lib/components/RailShell/RailShell.svelte";
  import MemoryFilterRail from "./MemoryFilterRail.svelte";
  import MemoryList from "./MemoryList.svelte";
  import {
    matchesFacets,
    allCount,
    facetCounts,
    sortComparators,
    type MemoryView,
    type FacetState,
    type SortKey,
  } from "./facet-filter";

  interface Props {
    /** Cold-load deep-link open id (from /memory/[id]); undefined on the index. */
    initialOpenId?: string;
    /** SSR warm-baseline list (index route only). */
    data?: { entries?: MemoryView[] };
  }

  let { initialOpenId, data }: Props = $props();

  const zeroOn = useZero();

  // `entries` seeded from SSR (warm baseline) and overwritten by Zero. Same
  // pattern as the current page: keep a plain array; under the Zero flag an
  // $effect maps `zeroSync.memory` rows in. `#bindMemory` already filters
  // deleted + pending_delete; archived is a tag, filtered client-side.
  // svelte-ignore state_referenced_locally
  let entries = $state<MemoryView[]>(data?.entries ?? []);
  $effect(() => {
    if (zeroOn) {
      entries = zeroSync.memory.map(toView);
    }
  });

  function toView(r: ZeroMemoryEntryRow): MemoryView {
    return {
      id: r.id,
      title: r.title,
      content: r.content,
      tags: Array.isArray(r.tags_json) ? r.tags_json : [],
      createdBy: r.created_by,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      recallCount: r.recall_count,
      lastRecalledAt: r.last_recalled_at
        ? new Date(r.last_recalled_at).toISOString()
        : null,
    };
  }

  // ── Filter / sort / search state ───────────────────────────────────────
  let selectedCategories = $state<Set<string>>(new Set());
  let selectedTags = $state<Set<string>>(new Set());
  let archivedOnly = $state(false);
  let sort = $state<SortKey>("recency");
  let creating = $state(false);
  let sheetOpen = $state(false);

  let query = $state("");
  let searchResults = $state<SearchResult[] | null>(null);
  let searching = $state(false);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let toast = $state<{ msg: string; kind: "ok" | "err" | "info" } | null>(null);

  const facetState = $derived<FacetState>({
    selectedCategories,
    selectedTags,
    archivedOnly,
  });

  function showToast(msg: string, kind: "ok" | "err" | "info" = "ok") {
    toast = { msg, kind };
    setTimeout(() => {
      toast = null;
    }, 4500);
  }

  // ── FTS search (unchanged: /api/memory/search, 250ms debounce) ─────────
  function scheduleSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    if (!query.trim()) {
      searchResults = null;
      return;
    }
    searchTimer = setTimeout(runSearch, 250);
  }

  async function runSearch() {
    const q = query.trim();
    if (!q) {
      searchResults = null;
      return;
    }
    searching = true;
    try {
      const params = new URLSearchParams({ q, limit: "50" });
      const r = await fetch(`/api/memory/search?${params}`);
      if (!r.ok) {
        searchResults = [];
        return;
      }
      searchResults = (await r.json()) as SearchResult[];
    } finally {
      searching = false;
    }
  }

  // Base set: FTS results (mapped back to MemoryView) when a query is active,
  // otherwise the full entry list. Facets + sort apply on top of this.
  const baseEntries = $derived<MemoryView[]>(
    searchResults !== null ? searchResults.map((r) => r.entry as MemoryView) : entries,
  );

  // ── Derived views via facet-filter ─────────────────────────────────────
  const filteredSorted = $derived(
    sortComparators[sort](baseEntries.filter((e) => matchesFacets(e, facetState))),
  );
  const counts = $derived(facetCounts(entries));
  // `total` (AC9): the size of the CURRENT filtered+searched view (pre-slice),
  // so the header denominator tracks active facets/search rather than the whole
  // corpus. Collapses to allCount(entries) when nothing is filtered, and to the
  // archived-set size under the Archived view. The rail's `All (n)` chip still
  // shows the whole-corpus count (see the allCount prop passed below).
  const total = $derived(filteredSorted.length);

  // Number of active facet selections, for the mobile `Filters (n)` badge.
  const activeFilterCount = $derived(
    selectedCategories.size + selectedTags.size + (archivedOnly ? 1 : 0),
  );

  // ── Open id (shallow-route warm; params cold) ──────────────────────────
  const openId = $derived($page.state.memoryId ?? initialOpenId ?? null);

  // ── Facet toggles ──────────────────────────────────────────────────────
  function toggleCategory(cat: string) {
    const next = new Set(selectedCategories);
    if (next.has(cat)) next.delete(cat);
    else next.add(cat);
    selectedCategories = next;
  }
  function toggleTag(tag: string) {
    const next = new Set(selectedTags);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    selectedTags = next;
  }
  function toggleArchived() {
    archivedOnly = !archivedOnly;
  }
  function clearAll() {
    selectedCategories = new Set();
    selectedTags = new Set();
    archivedOnly = false;
  }

  // Active-filter chips for the mobile top bar (AC18) — each removable.
  type ActiveChip = { key: string; label: string; remove: () => void };
  const activeChips = $derived<ActiveChip[]>([
    ...[...selectedCategories].map((c) => ({
      key: `cat:${c}`,
      label: c,
      remove: () => toggleCategory(c),
    })),
    ...[...selectedTags].map((t) => ({
      key: `tag:${t}`,
      label: `#${t}`,
      remove: () => toggleTag(t),
    })),
    ...(archivedOnly
      ? [{ key: "archived", label: "Archived", remove: () => toggleArchived() }]
      : []),
  ]);

  // ── Shallow routing helpers ────────────────────────────────────────────
  function openEntry(id: string) {
    pushState(`/memory/${encodeURIComponent(id)}`, { memoryId: id });
  }
  function collapse() {
    pushState("/memory", {});
  }
  function toggleOpen(id: string) {
    if (openId === id) collapse();
    else openEntry(id);
  }

  // ── Create / save / delete (Zero + REST fallback) ──────────────────────
  function startNew() {
    creating = true;
  }
  function cancelNew() {
    creating = false;
  }

  async function onCreate(payload: {
    title: string;
    content: string;
    tags: string[];
  }) {
    const { title, content, tags } = payload;
    if (!title.trim() || !content.trim()) return;
    if (zeroOn) {
      const id = slugifyMemoryId(title.trim());
      const result = zeroSync.createMemoryEntry({
        id,
        title: title.trim(),
        content,
        tags,
        createdBy: "user",
      });
      const sr = await result?.server;
      if (sr && sr.type === "error") {
        showToast(`create failed: ${sr.error.message}`, "err");
        return;
      }
      creating = false;
      showToast(`created ${id}`);
      // Open the new entry's accordion in place — shallow, NO goto (AC16).
      openEntry(id);
      return;
    }
    // REST fallback.
    const r = await fetch("/api/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: title.trim(), content, tags }),
    });
    if (!r.ok) {
      showToast(`create failed (${r.status})`, "err");
      return;
    }
    const created = (await r.json()) as { id: string };
    await refreshList();
    creating = false;
    showToast(`created ${created.id}`);
    openEntry(created.id);
  }

  async function onSave(
    id: string,
    payload: { title: string; content: string; tags: string[] },
  ) {
    const { title, content, tags } = payload;
    if (!title.trim() || !content.trim()) {
      showToast("title and content are required", "err");
      return;
    }
    if (zeroOn) {
      const result = zeroSync.updateMemoryEntry({
        id,
        title: title.trim(),
        content,
        tags,
      });
      const sr = await result?.server;
      if (sr && sr.type === "error") {
        showToast(`save failed: ${sr.error.message}`, "err");
        return;
      }
      // Optimistic: the reactive $effect reconciles when the Zero row updates.
      showToast("saved");
      return;
    }
    const r = await fetch(`/api/memory/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: title.trim(), content, tags }),
    });
    if (!r.ok) {
      showToast(`save failed (${r.status})`, "err");
      return;
    }
    await refreshList();
    showToast("saved");
  }

  async function onDelete(id: string) {
    const entry = entries.find((e) => e.id === id);
    const ok = await confirmDialog({
      title: `Delete memory "${entry?.title ?? id}"?`,
      description: `Delete memory ${id}? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    if (zeroOn) {
      // Fire-and-forget (current page idiom): the optimistic mutation removes
      // the row from Zero's local view; #bindMemory drops pending_delete.
      zeroSync.deleteMemoryEntry({ id });
      collapse();
      return;
    }
    const r = await fetch(`/api/memory/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      showToast(`delete failed (${r.status})`, "err");
      return;
    }
    await refreshList();
    collapse();
  }

  async function refreshList() {
    if (zeroOn) return; // the reactive query keeps entries in sync
    try {
      const r = await fetch("/api/memory");
      if (!r.ok) return;
      entries = (await r.json()) as MemoryView[];
    } catch {
      // ignore
    }
  }

  // ── Escape collapses an open accordion (AC19) when no sheet is open. The
  // RailShell owns Escape-for-the-sheet; this handles the page-level case. ──
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    if (sheetOpen) return; // sheet's own handler takes Escape
    if (openId) {
      e.preventDefault();
      collapse();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<header class="page-head">
  <h1>Memory</h1>
  <p class="page-lead">
    Persistent knowledge store. Auto-recalled into agent prompts.
  </p>
</header>

<RailShell railLabel="Filters" railCount={activeFilterCount} bind:sheetOpen>
  {#snippet rail()}
    <MemoryFilterRail
      state={facetState}
      counts={counts}
      allCount={allCount(entries)}
      ontogglecategory={(c) => {
        toggleCategory(c);
        sheetOpen = false;
      }}
      ontoggletag={(t) => {
        toggleTag(t);
        sheetOpen = false;
      }}
      ontogglearchived={() => {
        toggleArchived();
        sheetOpen = false;
      }}
      onclearall={() => {
        clearAll();
        sheetOpen = false;
      }} />
  {/snippet}

  {#snippet topbar()}
    <div class="topbar-search">
      <input
        class="input search-input"
        type="search"
        bind:value={query}
        oninput={scheduleSearch}
        placeholder="Search memories…"
        aria-label="Search memories" />
      {#if searching}
        <span class="search-status">Searching…</span>
      {/if}
    </div>
    {#if activeChips.length > 0}
      <div class="active-chips">
        {#each activeChips as chip (chip.key)}
          <span class="active-chip">
            <span class="active-chip-label">{chip.label}</span>
            <button
              type="button"
              class="active-chip-remove"
              aria-label={`remove ${chip.label} filter`}
              onclick={() => chip.remove()}>×</button>
          </span>
        {/each}
      </div>
    {/if}
  {/snippet}

  {#snippet main()}
    <!-- Desktop search lives in the main pane header region; on mobile the
         search is in the topbar snippet above. Render it here too so desktop
         users get search without the rail. -->
    <div class="desktop-search">
      <input
        class="input search-input"
        type="search"
        bind:value={query}
        oninput={scheduleSearch}
        placeholder="Search memories…"
        aria-label="Search memories" />
      {#if searching}
        <span class="search-status">Searching…</span>
      {:else if searchResults !== null}
        <span class="search-status">{searchResults.length} match{searchResults.length === 1 ? "" : "es"}</span>
      {/if}
    </div>
    <MemoryList
      entries={filteredSorted}
      total={total}
      sort={sort}
      openId={openId}
      creating={creating}
      onsortchange={(s) => (sort = s)}
      onnew={startNew}
      oncreate={onCreate}
      oncancelnew={cancelNew}
      ontoggle={toggleOpen}
      onsave={onSave}
      ondelete={onDelete} />
  {/snippet}
</RailShell>

{#if toast}
  <div class="toast toast-{toast.kind}" role="status" aria-live="polite">
    {toast.msg}
  </div>
{/if}

<style>
  .page-head {
    margin-bottom: 1rem;
  }
  .topbar-search,
  .desktop-search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .desktop-search {
    margin-bottom: 0.85rem;
  }
  /* The mobile topbar already lives below a viewport-driven layout; hide the
     duplicate desktop search bar on narrow viewports so search isn't doubled. */
  @media (max-width: 768px) {
    .desktop-search {
      display: none;
    }
  }
  .input {
    padding: 0.55rem 0.65rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.9rem;
    font-family: inherit;
  }
  .search-input {
    flex: 1;
    width: 100%;
  }
  .search-status {
    font-size: 0.75rem;
    color: var(--text-tertiary);
    white-space: nowrap;
  }
  .active-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .active-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    min-height: 44px;
    padding: 0.2rem 0.3rem 0.2rem 0.6rem;
    border-radius: 99px;
    background: var(--accent-glow);
    border: 1px solid var(--accent-primary);
    color: var(--text-primary);
    font-size: 0.75rem;
    font-family: var(--font-mono);
  }
  .active-chip-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    min-width: 44px;
    padding: 0 0.4rem;
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
    touch-action: manipulation;
  }
  .active-chip-remove:hover {
    color: var(--text-primary);
  }
  .active-chip-remove:focus-visible {
    outline: none;
    color: var(--accent-primary);
  }
  .toast {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    padding: 0.6rem 0.9rem;
    border-radius: var(--radius-sm);
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    box-shadow: var(--shadow-md);
    font-size: 0.85rem;
    z-index: 50;
    max-width: min(420px, 90vw);
  }
  .toast-ok {
    border-color: var(--status-success);
  }
  .toast-err {
    border-color: var(--status-error);
    color: var(--status-error);
  }
  .toast-info {
    border-color: var(--accent-primary);
  }
  @media (max-width: 1023px) {
    .input {
      font-size: 16px;
    }
  }
</style>
