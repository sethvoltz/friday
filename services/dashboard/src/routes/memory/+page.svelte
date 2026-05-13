<script lang="ts">
  import type { PageData } from "./$types";
  import type { MemoryEntry, SearchResult } from "@friday/memory";
  import { goto } from "$app/navigation";

  let { data }: { data: PageData } = $props();

  // svelte-ignore state_referenced_locally
  let entries = $state<MemoryEntry[]>(data.entries);
  let query = $state("");
  let activeTags = $state<Set<string>>(new Set());
  let searchResults = $state<SearchResult[] | null>(null);
  let searching = $state(false);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let toast = $state<{ msg: string; kind: "ok" | "err" | "info" } | null>(null);

  let newOpen = $state(false);
  let newTitle = $state("");
  let newContent = $state("");
  let newTags = $state("");
  let creating = $state(false);

  function showToast(msg: string, kind: "ok" | "err" | "info" = "ok") {
    toast = { msg, kind };
    setTimeout(() => {
      toast = null;
    }, 4500);
  }

  // FIX_FORWARD 6.8: tag chip palette derives from current entries.
  const allTags = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const e of entries) {
      for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  });

  // Visible entries: FTS results when there's an active query, otherwise the
  // full list filtered by tag chips client-side.
  const visible = $derived.by(() => {
    const tagSet = activeTags;
    if (searchResults !== null) {
      return searchResults.filter(
        (r) =>
          tagSet.size === 0 ||
          [...tagSet].every((t) => r.entry.tags.includes(t)),
      );
    }
    const tagFiltered =
      tagSet.size === 0
        ? entries
        : entries.filter((e) =>
            [...tagSet].every((t) => e.tags.includes(t)),
          );
    return tagFiltered.map<SearchResult>((e) => ({
      entry: e,
      score: 0,
      matchedOn: [],
    }));
  });

  function toggleTag(tag: string) {
    const next = new Set(activeTags);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    activeTags = next;
  }

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
      if (activeTags.size > 0) {
        params.set("tags", [...activeTags].join(","));
      }
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

  function snippet(content: string, q: string): string {
    if (!q) return content.slice(0, 220);
    const idx = content.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return content.slice(0, 220);
    const start = Math.max(0, idx - 60);
    const end = Math.min(content.length, idx + q.length + 160);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < content.length ? "…" : "";
    return prefix + content.slice(start, end) + suffix;
  }

  async function refreshList() {
    try {
      const r = await fetch("/api/memory");
      if (!r.ok) return;
      entries = (await r.json()) as MemoryEntry[];
    } catch {
      // ignore
    }
  }

  async function createMemory(e: Event) {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) return;
    creating = true;
    try {
      const tags = newTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const r = await fetch("/api/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: newTitle.trim(),
          content: newContent,
          tags,
        }),
      });
      if (!r.ok) {
        showToast(`create failed (${r.status})`, "err");
        return;
      }
      const created = (await r.json()) as MemoryEntry;
      newTitle = "";
      newContent = "";
      newTags = "";
      newOpen = false;
      showToast(`created ${created.id}`);
      await refreshList();
      // Jump to the new entry for quick editing.
      void goto(`/memory/${encodeURIComponent(created.id)}`);
    } finally {
      creating = false;
    }
  }
</script>

<header class="page-head">
  <h1>Memory</h1>
  <p class="page-lead">
    Persistent knowledge store. Auto-recalled into agent prompts.
  </p>
</header>

<div class="card">
  <div class="card-header">
    <h2>Search</h2>
    <button
      type="button"
      class="ghost primary"
      onclick={() => (newOpen = !newOpen)}>
      {newOpen ? "Cancel" : "New memory"}
    </button>
  </div>
  <input
    class="input search-input"
    type="search"
    bind:value={query}
    oninput={scheduleSearch}
    placeholder="FTS query: e.g. 'auth AND token', 'docker*'…" />
  <div class="search-meta">
    {#if searching}
      <span>Searching…</span>
    {:else if searchResults !== null}
      <span>{searchResults.length} match{searchResults.length === 1 ? "" : "es"} for <code>{query}</code></span>
    {:else}
      <span class="muted">Type to search. FTS5 syntax: <code>foo AND bar</code>, <code>"exact"</code>, <code>pre*</code>.</span>
    {/if}
  </div>

  {#if allTags.length > 0}
    <div class="chip-row">
      <span class="chip-label">Tags</span>
      {#each allTags as [tag, count] (tag)}
        <button
          type="button"
          class="chip"
          class:selected={activeTags.has(tag)}
          onclick={() => {
            toggleTag(tag);
            if (query.trim()) scheduleSearch();
          }}>
          #{tag} <span class="chip-count">({count})</span>
        </button>
      {/each}
      {#if activeTags.size > 0}
        <button
          type="button"
          class="chip ghost-chip"
          onclick={() => {
            activeTags = new Set();
            if (query.trim()) scheduleSearch();
          }}>
          clear
        </button>
      {/if}
    </div>
  {/if}
</div>

{#if newOpen}
  <div class="card">
    <div class="card-header"><h2>New memory</h2></div>
    <form class="newform" onsubmit={createMemory}>
      <label class="field">
        <span class="row-label">Title</span>
        <input class="input" bind:value={newTitle} required />
      </label>
      <label class="field">
        <span class="row-label">Tags (comma-separated, optional)</span>
        <input class="input" bind:value={newTags} placeholder="ops, runbook" />
      </label>
      <label class="field">
        <span class="row-label">Content (markdown)</span>
        <textarea class="textarea" rows="10" bind:value={newContent}></textarea>
      </label>
      <div class="actions">
        <button
          type="submit"
          class="ghost primary"
          disabled={creating || !newTitle.trim() || !newContent.trim()}>
          {creating ? "Creating…" : "Create memory"}
        </button>
      </div>
    </form>
  </div>
{/if}

<div class="card">
  <div class="card-header">
    <h2>{searchResults !== null ? "Results" : "All entries"}</h2>
    <span class="stat-detail">
      {visible.length} shown · {entries.length} total
    </span>
  </div>
  {#if visible.length === 0}
    <p class="empty-state">
      {searchResults !== null
        ? "No matches. Try loosening the query or clearing tag filters."
        : "No memories yet. Create one above or via `friday memory add`."}
    </p>
  {:else}
    <ul class="entry-list">
      {#each visible as r (r.entry.id)}
        <li class="entry">
          <div class="entry-head">
            <a
              href="/memory/{encodeURIComponent(r.entry.id)}"
              class="entry-title">{r.entry.title}</a>
            {#if r.score > 0}
              <span class="entry-score">score {r.score.toFixed(2)}</span>
            {/if}
          </div>
          {#if r.entry.tags.length > 0}
            <div class="entry-tags">
              {#each r.entry.tags as tag (tag)}
                <span class="tag">#{tag}</span>
              {/each}
            </div>
          {/if}
          <p class="entry-snippet">{snippet(r.entry.content, query)}</p>
          <div class="entry-meta">
            <span><code class="text-mono">{r.entry.id}</code></span>
            <span class="dot-sep"></span>
            <span>{r.entry.recallCount} recalls</span>
            <span class="dot-sep"></span>
            <span>by {r.entry.createdBy}</span>
            <span class="dot-sep"></span>
            <span>updated {new Date(r.entry.updatedAt).toLocaleString()}</span>
            {#if r.matchedOn.length > 0}
              <span class="dot-sep"></span>
              <span class="muted">matched: {r.matchedOn.join(", ")}</span>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

{#if toast}
  <div class="toast toast-{toast.kind}" role="status" aria-live="polite">
    {toast.msg}
  </div>
{/if}

<style>
  .search-input {
    width: 100%;
    margin-top: 0.5rem;
  }
  .input,
  .textarea {
    padding: 0.55rem 0.65rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.9rem;
    font-family: inherit;
  }
  .textarea {
    width: 100%;
    font-family: var(--font-mono);
    resize: vertical;
  }
  .search-meta {
    margin-top: 0.4rem;
    font-size: 0.78rem;
    color: var(--text-secondary);
  }
  .search-meta code {
    background: var(--bg-code);
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    font-family: var(--font-mono);
  }
  .muted {
    color: var(--text-tertiary);
  }
  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: center;
    margin-top: 0.75rem;
    font-size: 0.78rem;
  }
  .chip-label {
    color: var(--text-tertiary);
    text-transform: uppercase;
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    font-weight: 600;
    margin-right: 0.3rem;
  }
  .chip {
    padding: 0.22rem 0.6rem;
    border-radius: 99px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 0.75rem;
    cursor: pointer;
    font-family: var(--font-mono);
  }
  .chip:hover {
    color: var(--text-primary);
  }
  .chip.selected {
    background: var(--accent-glow);
    border-color: var(--accent-primary);
    color: var(--text-primary);
  }
  .chip-count {
    color: var(--text-tertiary);
    font-size: 0.65rem;
    margin-left: 0.15rem;
  }
  .ghost-chip {
    font-family: inherit;
    color: var(--text-tertiary);
  }
  button.primary {
    color: var(--accent-primary);
    border-color: var(--accent-primary);
  }
  .row-label {
    color: var(--text-tertiary);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .newform {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
  .entry-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .entry {
    padding: 0.6rem 0.75rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }
  .entry-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .entry-title {
    color: var(--text-primary);
    text-decoration: none;
    font-weight: 600;
    font-size: 0.95rem;
  }
  .entry-title:hover {
    color: var(--accent-primary);
  }
  .entry-score {
    color: var(--accent-primary);
    font-size: 0.72rem;
    font-family: var(--font-mono);
  }
  .entry-tags {
    display: flex;
    gap: 0.25rem;
    margin: 0.3rem 0;
    flex-wrap: wrap;
  }
  .tag {
    background: var(--bg-tertiary);
    color: var(--text-tertiary);
    padding: 0.1rem 0.4rem;
    border-radius: 99px;
    font-size: 0.68rem;
    font-family: var(--font-mono);
  }
  .entry-snippet {
    margin: 0.4rem 0 0.3rem;
    font-size: 0.82rem;
    color: var(--text-secondary);
    line-height: 1.4;
    word-break: break-word;
    max-height: 4.5em;
    overflow: hidden;
  }
  .entry-meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    font-size: 0.72rem;
    color: var(--text-tertiary);
  }
  .text-mono {
    font-family: var(--font-mono);
  }
  .dot-sep {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--text-tertiary);
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
</style>
