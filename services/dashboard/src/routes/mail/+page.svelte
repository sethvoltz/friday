<script lang="ts">
  import type { PageData } from "./$types";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { useZero, zeroSync, type ZeroMailRow } from "$lib/stores/zero.svelte";
  import Markdown from "$lib/components/Markdown/Markdown.svelte";

  let { data }: { data: PageData } = $props();

  const zeroOn = useZero();

  // ── state ────────────────────────────────────────────────────────────────

  // svelte-ignore state_referenced_locally
  let allMail = $state<ZeroMailRow[]>(
    data.mail.map(apiToZeroRow),
  );

  $effect(() => {
    if (zeroOn) {
      allMail = zeroSync.mail;
    }
  });

  // Convert SSR REST row (camelCase MailRow) to ZeroMailRow shape
  function apiToZeroRow(r: {
    id: number;
    fromAgent: string;
    toAgent: string;
    type: string;
    delivery: string;
    subject: string | null;
    threadId: string | null;
    body: string;
    meta: Record<string, unknown> | null;
    ts: number;
    readAt: number | null;
    closedAt: number | null;
    priority: string;
  }): ZeroMailRow {
    return {
      id: r.id,
      from_agent: r.fromAgent,
      to_agent: r.toAgent,
      type: r.type as ZeroMailRow["type"],
      delivery: r.delivery as ZeroMailRow["delivery"],
      subject: r.subject,
      thread_id: r.threadId,
      body: r.body,
      meta_json: r.meta,
      ts: r.ts,
      read_at: r.readAt,
      closed_at: r.closedAt,
      priority: r.priority as ZeroMailRow["priority"],
    };
  }

  // ── filters ──────────────────────────────────────────────────────────────

  let query = $state("");
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let searching = $state(false);
  let searchResults = $state<ZeroMailRow[] | null>(null);
  let searchTotal = $state(0);

  let filterAgent = $state("");
  let filterAgentMode = $state<"involves" | "to" | "from">("involves");
  let filterType = $state<Set<string>>(new Set());
  let filterDelivery = $state<Set<string>>(new Set());
  let filterPriority = $state<Set<string>>(new Set());
  let filterTimePreset = $state<"today" | "7d" | "30d" | "all">("all");
  let filterSince = $state("");
  let filterUntil = $state("");
  let filterThread = $state<string | null>(null);

  // ── selected item ────────────────────────────────────────────────────────

  let selectedId = $state<number | null>(
    $page.url.searchParams.has("id") ? Number($page.url.searchParams.get("id")) : null,
  );
  let mobileOpen = $state(false);
  let metaExpanded = $state(false);

  // ── derived visible list ─────────────────────────────────────────────────

  const visible = $derived.by((): ZeroMailRow[] => {
    const source = searchResults !== null ? searchResults : allMail;
    let rows = source;

    if (filterThread) {
      rows = rows.filter((r) => r.thread_id === filterThread);
    }

    if (searchResults === null) {
      // FTS results are already filtered server-side; apply remaining
      // metadata filters client-side only on the Zero slice.
      if (filterAgent) {
        if (filterAgentMode === "from") rows = rows.filter((r) => r.from_agent === filterAgent);
        else if (filterAgentMode === "to") rows = rows.filter((r) => r.to_agent === filterAgent);
        else
          rows = rows.filter(
            (r) => r.from_agent === filterAgent || r.to_agent === filterAgent,
          );
      }
      if (filterType.size > 0) rows = rows.filter((r) => filterType.has(r.type));
      if (filterDelivery.size > 0) rows = rows.filter((r) => filterDelivery.has(r.delivery));
      if (filterPriority.size > 0) rows = rows.filter((r) => filterPriority.has(r.priority));

      const now = Date.now();
      if (filterTimePreset === "today") {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        rows = rows.filter((r) => r.ts >= start.getTime());
      } else if (filterTimePreset === "7d") {
        rows = rows.filter((r) => r.ts >= now - 7 * 86_400_000);
      } else if (filterTimePreset === "30d") {
        rows = rows.filter((r) => r.ts >= now - 30 * 86_400_000);
      }
      if (filterSince) {
        const d = new Date(filterSince).getTime();
        if (!isNaN(d)) rows = rows.filter((r) => r.ts >= d);
      }
      if (filterUntil) {
        const d = new Date(filterUntil).getTime() + 86_400_000; // inclusive day
        if (!isNaN(d)) rows = rows.filter((r) => r.ts < d);
      }
    }

    return rows;
  });

  const selectedRow = $derived(
    selectedId !== null ? (visible.find((r) => r.id === selectedId) ?? null) : null,
  );

  const threadCount = $derived.by(() => {
    if (!selectedRow?.thread_id) return 0;
    return allMail.filter((r) => r.thread_id === selectedRow.thread_id).length;
  });

  // All agents seen in the mail corpus for the agent picker
  const knownAgents = $derived.by(() => {
    const set = new Set<string>();
    for (const r of allMail) {
      set.add(r.from_agent);
      set.add(r.to_agent);
    }
    return [...set].sort();
  });

  // ── virtual scroll ───────────────────────────────────────────────────────

  const ITEM_H = 72; // px per row
  const OVERSCAN = 5; // extra rows above/below viewport

  let scrollEl = $state<HTMLElement | null>(null);
  let scrollTop = $state(0);
  let viewportH = $state(600);

  $effect(() => {
    const el = scrollEl;
    if (!el) return;
    const onScroll = () => (scrollTop = el.scrollTop);
    const ro = new ResizeObserver(() => (viewportH = el.clientHeight));
    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  });

  const startIdx = $derived(Math.max(0, Math.floor(scrollTop / ITEM_H) - OVERSCAN));
  const endIdx = $derived(
    Math.min(visible.length, Math.ceil((scrollTop + viewportH) / ITEM_H) + OVERSCAN),
  );
  const paddingTop = $derived(startIdx * ITEM_H);
  const paddingBottom = $derived((visible.length - endIdx) * ITEM_H);
  const windowedRows = $derived(visible.slice(startIdx, endIdx));
  const totalHeight = $derived(visible.length * ITEM_H);

  // ── search ───────────────────────────────────────────────────────────────

  function scheduleSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    if (!query.trim()) {
      searchResults = null;
      return;
    }
    searchTimer = setTimeout(runSearch, 300);
  }

  async function runSearch() {
    const q = query.trim();
    if (!q) {
      searchResults = null;
      return;
    }
    searching = true;
    try {
      const params = new URLSearchParams({ q, limit: "200" });
      if (filterAgent) params.set(filterAgentMode, filterAgent);
      if (filterType.size > 0) params.set("type", [...filterType].join(","));
      if (filterDelivery.size > 0) params.set("delivery", [...filterDelivery].join(","));
      if (filterPriority.size > 0) params.set("priority", [...filterPriority].join(","));
      if (filterTimePreset !== "all") {
        const now = Date.now();
        if (filterTimePreset === "today") {
          const d = new Date();
          d.setHours(0, 0, 0, 0);
          params.set("since", d.toISOString());
        } else if (filterTimePreset === "7d") {
          params.set("since", new Date(now - 7 * 86_400_000).toISOString());
        } else if (filterTimePreset === "30d") {
          params.set("since", new Date(now - 30 * 86_400_000).toISOString());
        }
      }
      if (filterSince) params.set("since", new Date(filterSince).toISOString());
      if (filterUntil) params.set("until", new Date(filterUntil + "T23:59:59").toISOString());

      const r = await fetch(`/api/mail/search?${params}`);
      if (!r.ok) {
        searchResults = [];
        return;
      }
      const data = (await r.json()) as { results: ZeroMailRow[]; total: number };
      searchResults = data.results;
      searchTotal = data.total;
    } finally {
      searching = false;
    }
  }

  function clearSearch() {
    query = "";
    searchResults = null;
  }

  // ── actions ───────────────────────────────────────────────────────────────

  function selectRow(id: number) {
    selectedId = id;
    metaExpanded = false;
    void goto(`/mail?id=${id}`, { replaceState: true, noScroll: true });
  }

  async function doMarkRead(row: ZeroMailRow) {
    if (row.delivery !== "pending") return;
    zeroSync.markMailRead(row.id);
  }

  async function doClose(row: ZeroMailRow) {
    if (row.delivery === "closed") return;
    zeroSync.closeMailRow(row.id);
  }

  function filterByThread(threadId: string) {
    filterThread = threadId;
    selectedId = null;
  }

  function clearThread() {
    filterThread = null;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  function relTime(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function toggleSet(set: Set<string>, val: string): Set<string> {
    const next = new Set(set);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    return next;
  }
</script>

<div class="mail-layout">
  <!-- ── Mobile header dropdown ────────────────────────────────────────── -->
  <div class="mobile-bar">
    <button
      type="button"
      class="mobile-toggle"
      onclick={() => (mobileOpen = !mobileOpen)}
      aria-expanded={mobileOpen}>
      {#if filterThread}
        Thread: {filterThread.slice(0, 12)}…
      {:else}
        {visible.length} messages {query ? `· "${query}"` : ""}
      {/if}
      <span class="mobile-chevron" class:open={mobileOpen}>▾</span>
    </button>

    {#if mobileOpen}
      <div class="mobile-dropdown">
        <!-- Search tab -->
        <div class="mobile-section">
          <span class="section-label">Search</span>
          <input
            class="search-input"
            type="search"
            bind:value={query}
            oninput={scheduleSearch}
            placeholder="Full-text search…" />
          {#if searching}<span class="muted">Searching…</span>{/if}
        </div>

        <!-- Filters tab -->
        <div class="mobile-section">
          <span class="section-label">Agent</span>
          <div class="agent-row">
            <input
              class="agent-input"
              list="agent-list"
              bind:value={filterAgent}
              oninput={() => { if (query) scheduleSearch(); }}
              placeholder="Agent name…" />
            <datalist id="agent-list">
              {#each knownAgents as a (a)}
                <option value={a}></option>
              {/each}
            </datalist>
            <select
              class="mode-select"
              bind:value={filterAgentMode}
              onchange={() => { if (query) scheduleSearch(); }}>
              <option value="involves">involves</option>
              <option value="from">from</option>
              <option value="to">to</option>
            </select>
          </div>
        </div>

        <div class="mobile-section">
          <span class="section-label">Type</span>
          <div class="chip-row">
            {#each ["message", "notification", "task"] as t (t)}
              <button
                type="button"
                class="chip"
                class:selected={filterType.has(t)}
                onclick={() => { filterType = toggleSet(filterType, t); if (query) scheduleSearch(); }}>
                {t}
              </button>
            {/each}
          </div>
        </div>

        <div class="mobile-section">
          <span class="section-label">Delivery</span>
          <div class="chip-row">
            {#each ["pending", "read", "closed"] as d (d)}
              <button
                type="button"
                class="chip"
                class:selected={filterDelivery.has(d)}
                onclick={() => { filterDelivery = toggleSet(filterDelivery, d); if (query) scheduleSearch(); }}>
                {d}
              </button>
            {/each}
          </div>
        </div>

        <div class="mobile-section">
          <span class="section-label">Priority</span>
          <div class="chip-row">
            {#each ["normal", "critical"] as p (p)}
              <button
                type="button"
                class="chip"
                class:selected={filterPriority.has(p)}
                onclick={() => { filterPriority = toggleSet(filterPriority, p); if (query) scheduleSearch(); }}>
                {p}
              </button>
            {/each}
          </div>
        </div>

        <div class="mobile-section">
          <span class="section-label">Time</span>
          <div class="chip-row">
            {#each [["today","Today"],["7d","7d"],["30d","30d"],["all","All"]] as [v, l] (v)}
              <button
                type="button"
                class="chip"
                class:selected={filterTimePreset === v}
                onclick={() => { filterTimePreset = v as typeof filterTimePreset; if (query) scheduleSearch(); }}>
                {l}
              </button>
            {/each}
          </div>
          {#if filterTimePreset === "all"}
            <div class="date-range">
              <input type="date" class="date-input" bind:value={filterSince} />
              <span>–</span>
              <input type="date" class="date-input" bind:value={filterUntil} />
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  <!-- ── Sidebar ────────────────────────────────────────────────────────── -->
  <aside class="sidebar">
    <div class="sidebar-search">
      <input
        class="search-input"
        type="search"
        bind:value={query}
        oninput={scheduleSearch}
        placeholder="Search mail…"
        aria-label="Search mail" />
      {#if searching}
        <span class="search-status muted">Searching…</span>
      {:else if searchResults !== null}
        <span class="search-status muted">{searchResults.length} of {searchTotal}</span>
      {/if}
    </div>

    {#if filterThread}
      <div class="filter-banner">
        Thread filter active
        <button type="button" class="clear-filter" onclick={clearThread}>✕</button>
      </div>
    {/if}

    <!-- Filters -->
    <div class="filters">
      <div class="filter-row">
        <input
          class="agent-input"
          list="agent-list-sidebar"
          bind:value={filterAgent}
          oninput={() => { if (query) scheduleSearch(); }}
          placeholder="Agent…"
          aria-label="Filter by agent" />
        <datalist id="agent-list-sidebar">
          {#each knownAgents as a (a)}
            <option value={a}></option>
          {/each}
        </datalist>
        <select
          class="mode-select"
          bind:value={filterAgentMode}
          onchange={() => { if (query) scheduleSearch(); }}
          aria-label="Agent filter mode">
          <option value="involves">involves</option>
          <option value="from">from</option>
          <option value="to">to</option>
        </select>
      </div>

      <div class="chip-row">
        {#each ["message", "notification", "task"] as t (t)}
          <button
            type="button"
            class="chip"
            class:selected={filterType.has(t)}
            onclick={() => { filterType = toggleSet(filterType, t); if (query) scheduleSearch(); }}>
            {t}
          </button>
        {/each}
      </div>

      <div class="chip-row">
        {#each ["pending", "read", "closed"] as d (d)}
          <button
            type="button"
            class="chip dot-chip"
            class:selected={filterDelivery.has(d)}
            onclick={() => { filterDelivery = toggleSet(filterDelivery, d); if (query) scheduleSearch(); }}>
            <span class="dot dot-{d}" aria-hidden="true"></span>{d}
          </button>
        {/each}
      </div>

      <div class="chip-row">
        {#each ["normal", "critical"] as p (p)}
          <button
            type="button"
            class="chip"
            class:selected={filterPriority.has(p)}
            onclick={() => { filterPriority = toggleSet(filterPriority, p); if (query) scheduleSearch(); }}>
            {p}
          </button>
        {/each}
      </div>

      <div class="chip-row time-row">
        {#each [["today","Today"],["7d","7d"],["30d","30d"],["all","All"]] as [v, l] (v)}
          <button
            type="button"
            class="chip"
            class:selected={filterTimePreset === v}
            onclick={() => { filterTimePreset = v as typeof filterTimePreset; if (query) scheduleSearch(); }}>
            {l}
          </button>
        {/each}
      </div>
      {#if filterTimePreset === "all" && (filterSince || filterUntil || true)}
        <div class="date-range">
          <input type="date" class="date-input" bind:value={filterSince} aria-label="Since date" />
          <span class="date-sep">–</span>
          <input type="date" class="date-input" bind:value={filterUntil} aria-label="Until date" />
        </div>
      {/if}
    </div>

    <div class="list-meta muted">
      {visible.length} shown
      {#if allMail.length !== visible.length}· {allMail.length} total{/if}
    </div>

    <!-- Virtual scroll container -->
    <div
      class="mail-list"
      bind:this={scrollEl}
      style="height: {Math.max(200, viewportH - 10)}px; overflow-y: auto;">
      <div style="height: {totalHeight}px; position: relative;">
        <div style="position: absolute; top: {paddingTop}px; width: 100%;">
          {#each windowedRows as row (row.id)}
            <button
              type="button"
              class="mail-row"
              class:selected={selectedId === row.id}
              onclick={() => selectRow(row.id)}
              style="height: {ITEM_H}px;">
              <div class="row-top">
                <span class="row-subject">
                  {row.subject ?? "(no subject)"}
                </span>
                <span class="row-time muted">{relTime(row.ts)}</span>
              </div>
              <div class="row-agents muted">
                <code>{row.from_agent}</code> → <code>{row.to_agent}</code>
              </div>
              <div class="row-badges">
                <span class="badge-type badge-{row.type}">{row.type}</span>
                <span class="dot dot-{row.delivery}" title={row.delivery} aria-label={row.delivery}></span>
                {#if row.priority === "critical"}
                  <span class="badge-critical">!</span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      </div>
    </div>
  </aside>

  <!-- ── Detail pane ────────────────────────────────────────────────────── -->
  <main class="detail">
    {#if selectedRow}
      {@const row = selectedRow}
      <div class="detail-inner">
        <!-- Metadata header -->
        <div class="detail-header">
          <h2 class="detail-subject">{row.subject ?? "(no subject)"}</h2>
          <dl class="detail-meta">
            <dt>from</dt>
            <dd><code>{row.from_agent}</code></dd>
            <dt>to</dt>
            <dd><code>{row.to_agent}</code></dd>
            <dt>time</dt>
            <dd>
              {new Date(row.ts).toLocaleString()}
              <span class="muted">({relTime(row.ts)})</span>
            </dd>
            <dt>type</dt>
            <dd><span class="badge-type badge-{row.type}">{row.type}</span></dd>
            <dt>priority</dt>
            <dd class:critical={row.priority === "critical"}>{row.priority}</dd>
            <dt>delivery</dt>
            <dd>
              <span class="dot dot-{row.delivery}" aria-hidden="true"></span>
              {row.delivery}
              {#if row.read_at}
                <span class="muted">at {new Date(row.read_at).toLocaleString()}</span>
              {:else if row.closed_at}
                <span class="muted">at {new Date(row.closed_at).toLocaleString()}</span>
              {/if}
            </dd>
          </dl>
        </div>

        <!-- Thread affordance -->
        {#if row.thread_id && threadCount > 1}
          <div class="thread-bar">
            <button
              type="button"
              class="thread-btn"
              onclick={() => filterByThread(row.thread_id!)}>
              {threadCount} messages in thread
            </button>
          </div>
        {/if}

        <!-- Body -->
        <div class="detail-body">
          <Markdown source={row.body} />
        </div>

        <!-- meta_json inspector -->
        {#if row.meta_json && Object.keys(row.meta_json).length > 0}
          <div class="meta-inspector">
            <button
              type="button"
              class="meta-toggle"
              onclick={() => (metaExpanded = !metaExpanded)}
              aria-expanded={metaExpanded}>
              <span class="chevron" class:open={metaExpanded}>▶</span>
              meta
            </button>
            {#if metaExpanded}
              <pre class="meta-json">{JSON.stringify(row.meta_json, null, 2)}</pre>
            {/if}
          </div>
        {/if}

        <!-- Action bar -->
        <div class="action-bar">
          <button
            type="button"
            class="action-btn"
            disabled={row.delivery !== "pending"}
            onclick={() => doMarkRead(row)}>
            Mark read
          </button>
          <button
            type="button"
            class="action-btn"
            disabled={row.delivery === "closed"}
            onclick={() => doClose(row)}>
            Close
          </button>
        </div>
      </div>
    {:else}
      <div class="detail-empty">
        <p class="muted">Select a message to read it.</p>
      </div>
    {/if}
  </main>
</div>

<style>
  /* ── layout ────────────────────────────────────────────────────────────── */
  .mail-layout {
    display: flex;
    height: calc(100vh - 5.5rem);
    overflow: hidden;
    gap: 0;
  }

  .sidebar {
    width: 320px;
    flex-shrink: 0;
    border-right: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    gap: 0;
    overflow: hidden;
    background: var(--bg-primary);
  }

  .detail {
    flex: 1 1 0;
    min-width: 0;
    overflow-y: auto;
    background: var(--bg-primary);
  }

  .mobile-bar {
    display: none;
  }

  /* ── sidebar internals ──────────────────────────────────────────────────── */
  .sidebar-search {
    padding: 0.75rem 0.75rem 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .search-input {
    width: 100%;
    padding: 0.45rem 0.6rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    font-family: inherit;
  }

  .search-status {
    font-size: 0.72rem;
  }

  .filter-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--accent-glow);
    border-bottom: 1px solid var(--accent-primary);
    padding: 0.35rem 0.75rem;
    font-size: 0.75rem;
    color: var(--accent-primary);
  }

  .clear-filter {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--accent-primary);
    font-size: 0.8rem;
    padding: 0 0.25rem;
  }

  .filters {
    padding: 0.5rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .filter-row {
    display: flex;
    gap: 0.4rem;
  }

  .agent-input {
    flex: 1;
    padding: 0.35rem 0.5rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.8rem;
    font-family: inherit;
    min-width: 0;
  }

  .mode-select {
    padding: 0.35rem 0.4rem;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    cursor: pointer;
    flex-shrink: 0;
  }

  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .chip {
    padding: 0.2rem 0.55rem;
    border-radius: 99px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 0.72rem;
    cursor: pointer;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    transition: all var(--transition-fast);
  }

  .chip:hover {
    color: var(--text-primary);
    border-color: var(--border-primary);
  }

  .chip.selected {
    background: var(--accent-glow);
    border-color: var(--accent-primary);
    color: var(--text-primary);
  }

  .date-range {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-top: 0.25rem;
  }

  .date-input {
    flex: 1;
    padding: 0.3rem 0.4rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.72rem;
    font-family: inherit;
    min-width: 0;
  }

  .date-sep {
    color: var(--text-tertiary);
    font-size: 0.8rem;
    flex-shrink: 0;
  }

  .list-meta {
    padding: 0.3rem 0.75rem;
    font-size: 0.72rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  /* ── mail list rows ─────────────────────────────────────────────────────── */
  .mail-list {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .mail-row {
    display: block;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-primary);
    text-align: left;
    cursor: pointer;
    transition: background var(--transition-fast);
    box-sizing: border-box;
    overflow: hidden;
  }

  .mail-row:hover {
    background: var(--bg-secondary);
  }

  .mail-row.selected {
    background: var(--accent-glow);
    border-left: 2px solid var(--accent-primary);
  }

  .row-top {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.2rem;
  }

  .row-subject {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  .row-time {
    font-size: 0.7rem;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .row-agents {
    font-size: 0.72rem;
    margin-bottom: 0.25rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-agents code {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: var(--text-tertiary);
  }

  .row-badges {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  /* ── delivery dots ──────────────────────────────────────────────────────── */
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .dot-pending {
    background: #f59e0b;
  }

  .dot-read {
    background: var(--text-tertiary);
  }

  .dot-closed {
    background: #10b981;
  }

  /* ── type badges ────────────────────────────────────────────────────────── */
  .badge-type {
    font-size: 0.65rem;
    padding: 0.1rem 0.4rem;
    border-radius: 99px;
    font-family: var(--font-mono);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
  }

  .badge-task {
    background: rgba(var(--accent-primary-rgb, 99 102 241) / 0.15);
    color: var(--accent-primary);
  }

  .badge-critical {
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--status-error);
  }

  /* ── detail pane ────────────────────────────────────────────────────────── */
  .detail-inner {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 780px;
  }

  .detail-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 50%;
  }

  .detail-subject {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0;
    color: var(--text-primary);
  }

  .detail-meta {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.3rem 0.75rem;
    font-size: 0.82rem;
    margin: 0;
  }

  .detail-meta dt {
    color: var(--text-tertiary);
    text-transform: uppercase;
    font-size: 0.65rem;
    letter-spacing: 0.06em;
    font-weight: 600;
    align-self: center;
  }

  .detail-meta dd {
    margin: 0;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }

  .detail-meta code {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    background: var(--bg-code);
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    color: var(--text-secondary);
  }

  .critical {
    color: var(--status-error);
    font-weight: 600;
  }

  .thread-bar {
    padding: 0.5rem 0;
  }

  .thread-btn {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 0.35rem 0.75rem;
    font-size: 0.8rem;
    color: var(--accent-primary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .thread-btn:hover {
    background: var(--accent-glow);
    border-color: var(--accent-primary);
  }

  .detail-body {
    font-size: 0.9rem;
    line-height: 1.6;
  }

  .meta-inspector {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .meta-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.45rem 0.75rem;
    background: var(--bg-secondary);
    border: none;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    cursor: pointer;
    text-align: left;
    transition: background var(--transition-fast);
  }

  .meta-toggle:hover {
    background: var(--bg-tertiary);
  }

  .chevron {
    font-size: 0.65rem;
    transition: transform var(--transition-fast);
    display: inline-block;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .meta-json {
    margin: 0;
    padding: 0.75rem;
    background: var(--bg-code);
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-x: auto;
    max-height: 300px;
    overflow-y: auto;
  }

  .action-bar {
    display: flex;
    gap: 0.5rem;
    padding-top: 0.25rem;
    border-top: 1px solid var(--border-subtle);
  }

  .action-btn {
    padding: 0.4rem 0.9rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 0.82rem;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .action-btn:hover:not(:disabled) {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
    background: var(--accent-glow);
  }

  .action-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .muted {
    color: var(--text-tertiary);
  }

  /* ── mobile ─────────────────────────────────────────────────────────────── */
  @media (max-width: 1023px) {
    .mail-layout {
      flex-direction: column;
      height: auto;
    }

    .sidebar {
      width: 100%;
      border-right: none;
      border-bottom: 1px solid var(--border-subtle);
    }

    .mail-list {
      max-height: 300px;
    }

    .mobile-bar {
      display: block;
    }

    .sidebar {
      display: none;
    }

    .mobile-dropdown {
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-top: 0.5rem;
    }

    .mobile-section {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }

    .section-label {
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 600;
      color: var(--text-tertiary);
    }

    .mobile-toggle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 0.6rem 0.75rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      font-size: 0.85rem;
      color: var(--text-primary);
      cursor: pointer;
      text-align: left;
    }

    .mobile-chevron {
      font-size: 0.8rem;
      color: var(--text-tertiary);
      transition: transform var(--transition-fast);
    }

    .mobile-chevron.open {
      transform: rotate(180deg);
    }

    /* Show list inline on mobile below the dropdown */
    .mail-layout {
      display: grid;
      grid-template-rows: auto auto 1fr;
    }

    .detail {
      min-height: 300px;
    }
  }

  @media (min-width: 1024px) {
    .mobile-bar {
      display: none;
    }

    .sidebar {
      display: flex;
    }
  }
</style>
