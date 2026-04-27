<script lang="ts">
  import { page } from '$app/stores';
  import { invalidateAll } from '$app/navigation';
  import { getDataVersion } from '$lib/events.svelte';
  import type { Proposal, ProposalStatus } from '@friday/evolve';

  let { data, children } = $props();

  // Re-fetch when SSE events arrive — same pattern memory route uses.
  let lastVersion = $state(getDataVersion());
  $effect(() => {
    const v = getDataVersion();
    if (v !== lastVersion) {
      lastVersion = v;
      invalidateAll();
    }
  });

  const proposals: Proposal[] = $derived(data.proposals ?? []);
  const allStatuses: string[] = $derived(data.allStatuses ?? []);

  // Default: hide rejected/applied/superseded — show only open + critical + approved.
  const DEFAULT_VISIBLE: ProposalStatus[] = ['open', 'critical', 'approved'];
  let selectedStatuses = $state<Set<string>>(new Set(DEFAULT_VISIBLE));
  let showFilter = $state(false);

  const allSelected = $derived(
    allStatuses.every((s) => selectedStatuses.has(s))
  );
  const filterLabel = $derived(
    allSelected || allStatuses.length === 0
      ? 'All statuses'
      : `${selectedStatuses.size} of ${allStatuses.length} statuses`
  );

  const statusCounts = $derived(() => {
    const counts = new Map<string, number>();
    for (const p of proposals) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
    return counts;
  });

  const filteredProposals = $derived(
    proposals.filter((p) => selectedStatuses.has(p.status))
  );

  function toggleStatus(s: string) {
    const next = new Set(selectedStatuses);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    selectedStatuses = next;
  }

  function selectAll() {
    selectedStatuses = new Set(allStatuses);
  }

  function selectNone() {
    selectedStatuses = new Set();
  }

  function isActive(path: string): boolean {
    return $page.url.pathname === path;
  }

  function statusBadgeClass(s: string): string {
    return `status-${s}`;
  }
</script>

<div class="evolve-layout">
  <aside class="sidebar">
    <div class="sidebar-header">
      <h2>Evolve</h2>
      {#if allStatuses.length > 0}
        <div class="filter-wrapper">
          <button class="filter-btn" onclick={() => (showFilter = !showFilter)}>
            {filterLabel} ▾
          </button>
          {#if showFilter}
            <div class="filter-dropdown">
              <div class="filter-actions">
                <button onclick={selectAll} class="filter-action" disabled={allSelected}>All</button>
                <button onclick={selectNone} class="filter-action" disabled={selectedStatuses.size === 0}>None</button>
              </div>
              {#each allStatuses as status}
                <label class="filter-option">
                  <input
                    type="checkbox"
                    checked={selectedStatuses.has(status)}
                    onchange={() => toggleStatus(status)}
                  />
                  <span class="filter-tag-name">{status}</span>
                  <span class="filter-tag-count">({statusCounts().get(status) ?? 0})</span>
                </label>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <div class="sidebar-content">
      {#each filteredProposals as p}
        <a
          class="sidebar-item"
          class:active={isActive(`/evolve/${p.id}`)}
          href="/evolve/{p.id}"
        >
          <span class="item-status {statusBadgeClass(p.status)}">{p.status}</span>
          <span class="item-name">{p.title}</span>
          <span class="item-score">{p.score}</span>
        </a>
      {/each}
      {#if filteredProposals.length === 0}
        <div class="sidebar-empty">
          {#if proposals.length === 0}
            No proposals yet — the daily meta-agent runs at 4am.
          {:else}
            No proposals match the selected statuses.
          {/if}
        </div>
      {/if}
    </div>

    <div class="sidebar-footer">
      <span class="proposal-count">
        {filteredProposals.length}{filteredProposals.length !== proposals.length ? ` of ${proposals.length}` : ''} proposals
      </span>
    </div>
  </aside>

  <section class="content">
    {@render children()}
  </section>
</div>

<style>
  .evolve-layout {
    display: flex;
    gap: 1rem;
    height: calc(100vh - 4.5rem);
    margin: -1.5rem;
    padding: 1rem 1.5rem 1rem;
  }

  .sidebar {
    width: 320px;
    min-width: 320px;
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .sidebar-header {
    padding: 1rem 1rem 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .sidebar-header h2 {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0.5rem 0 0;
  }

  .filter-wrapper { position: relative; margin-top: 0.5rem; }

  .filter-btn {
    width: 100%;
    padding: 0.35rem 0.5rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    transition: all var(--transition-fast);
  }
  .filter-btn:hover { border-color: var(--border-primary); color: var(--text-primary); }

  .filter-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0; right: 0;
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-md, 0 4px 12px rgba(0,0,0,0.15));
    z-index: 10;
    max-height: 200px;
    overflow-y: auto;
    padding: 0.25rem 0;
  }

  .filter-actions {
    display: flex;
    gap: 0.5rem;
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
    margin-bottom: 0.25rem;
  }

  .filter-action {
    font-size: 0.7rem;
    color: var(--accent-primary);
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0;
  }
  .filter-action:disabled { color: var(--text-tertiary); cursor: default; }

  .filter-option {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .filter-option:hover { background: var(--bg-tertiary); }
  .filter-option input { margin: 0; accent-color: var(--accent-primary); }
  .filter-tag-name { flex: 1; }
  .filter-tag-count { color: var(--text-tertiary); font-size: 0.7rem; }

  .sidebar-content {
    flex: 1;
    padding: 0.5rem 0;
    overflow-y: auto;
  }

  .sidebar-item {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
    text-decoration: none;
    cursor: pointer;
    transition: background var(--transition-fast);
  }
  .sidebar-item:hover { background: var(--bg-tertiary); }
  .sidebar-item.active {
    background: var(--accent-glow);
    color: var(--accent-primary);
  }

  .item-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-score {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--text-tertiary);
  }

  .item-status {
    display: inline-block;
    padding: 0.1rem 0.4rem;
    font-size: 0.6rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    border-radius: 99px;
    background: var(--bg-tertiary);
    color: var(--text-tertiary);
  }
  .item-status.status-critical { background: #ef4444; color: white; }
  .item-status.status-open { background: var(--accent-glow); color: var(--accent-primary); }
  .item-status.status-approved { background: #facc15; color: #422006; }
  .item-status.status-applied { background: #22c55e; color: white; }
  .item-status.status-rejected { background: var(--bg-tertiary); color: var(--text-tertiary); }
  .item-status.status-superseded { background: var(--bg-tertiary); color: var(--text-tertiary); }

  .sidebar-empty {
    padding: 1.5rem 1rem;
    text-align: center;
    font-size: 0.8rem;
    color: var(--text-tertiary);
  }

  .sidebar-footer {
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border-subtle);
    text-align: center;
  }

  .proposal-count {
    font-size: 0.7rem;
    color: var(--text-tertiary);
  }

  .content {
    flex: 1;
    overflow: hidden;
    padding: 0.5rem 1rem;
    display: flex;
    flex-direction: column;
  }
</style>
