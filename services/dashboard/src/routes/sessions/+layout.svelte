<script lang="ts">
  import { page } from '$app/stores';
  import { invalidateAll } from '$app/navigation';
  import { getLiveStatus, getConnection, getDataVersion } from '$lib/events.svelte';
  import type { AgentTreeNode, BareSessionGroup } from './+layout.server';

  let { data, children } = $props();

  let showHistory = $state(false);
  const connection = $derived(getConnection());

  // Re-fetch sidebar data when SSE events arrive
  let lastVersion = $state(getDataVersion());
  $effect(() => {
    const v = getDataVersion();
    if (v !== lastVersion) {
      lastVersion = v;
      invalidateAll();
    }
  });

  const agentTree: AgentTreeNode[] = $derived(data.agentTree ?? []);
  const bareGroups: BareSessionGroup[] = $derived(data.bareSessionGroups ?? []);

  function statusDot(status: string): string {
    switch (status) {
      case 'active': return '●';
      case 'idle': return '○';
      case 'destroyed': return '◌';
      default: return '○';
    }
  }

  function statusClass(status: string): string {
    switch (status) {
      case 'active': return 'status-active';
      case 'idle': return 'status-idle';
      case 'destroyed': return 'status-destroyed';
      default: return 'status-idle';
    }
  }

  function typeIcon(type: string): string {
    switch (type) {
      case 'orchestrator': return '👑';
      case 'builder': return '🔨';
      case 'helper': return '⚡';
      default: return '💬';
    }
  }

  function fmtDate(d: string): string {
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function formatDateRange(firstAt: string, lastAt: string): string {
    if (!firstAt) return '';
    if (fmtDate(firstAt) === fmtDate(lastAt)) return fmtDate(firstAt);
    return `${fmtDate(firstAt)} – ${fmtDate(lastAt)}`;
  }

  function formatDateOpen(firstAt: string): string {
    if (!firstAt) return '';
    return `${fmtDate(firstAt)} –`;
  }

  function isActive(path: string): boolean {
    return $page.url.pathname === path;
  }
</script>

<div class="sessions-layout">
  <aside class="sidebar">
    <div class="sidebar-header">
      <h2>Sessions</h2>
    </div>

    <div class="sidebar-content">
      {#each agentTree as node}
        {@render agentNode(node, 0)}
      {/each}

      {#if bareGroups.length > 0}
        <div class="sidebar-group-label">BARE</div>
        {#each bareGroups as group}
          {@const currentSession = group.sessions.find(s => s.active)}
          {@const formerSessions = group.sessions.filter(s => !s.active)}
          <a
            class="sidebar-item"
            class:active={isActive(`/sessions/bare/${group.channelId}`)}
            href="/sessions/bare/{group.channelId}"
          >
            <span class="item-icon">{group.kind === 'dm' ? '💬' : '#'}</span>
            <span class="item-name">{group.label}</span>
            {#if group.currentSessionStart}
              <span class="item-date">{formatDateOpen(group.currentSessionStart)}</span>
            {/if}
            {#if currentSession}
              <span class="item-dot status-active">●</span>
            {:else}
              <span class="item-dot status-idle">○</span>
            {/if}
          </a>
          {#if showHistory && formerSessions.length > 0}
            {#each formerSessions as session}
              <a
                class="sidebar-item former"
                class:active={isActive(`/sessions/bare/${group.channelId}/${session.sessionId}`)}
                href="/sessions/bare/{group.channelId}/{session.sessionId}"
              >
                <span class="item-icon-spacer"></span>
                <span class="item-name">{group.label}</span>
                <span class="item-date">{formatDateRange(session.firstAt, session.lastAt)}</span>
                <span class="item-dot status-destroyed">◌</span>
              </a>
            {/each}
          {/if}
        {/each}
      {/if}
    </div>

    <div class="sidebar-footer">
      <div class="live-indicator">
        {#if connection.connected}
          <span class="live-dot connected">● Live</span>
        {:else}
          <span class="live-dot disconnected">○ Offline</span>
        {/if}
      </div>
      <button class="history-toggle" onclick={() => showHistory = !showHistory}>
        {showHistory ? 'Hide history' : 'Show history'}
      </button>
    </div>
  </aside>

  <section class="content">
    {@render children()}
  </section>
</div>

{#snippet agentNode(node: AgentTreeNode, depth: number)}
  {@const isOrch = node.entry.type === 'orchestrator'}

  {#if isOrch && depth === 0}
    <div class="sidebar-group-label">ORCHESTRATOR</div>
  {/if}

  <a
    class="sidebar-item depth-{depth}"
    class:active={isActive(`/sessions/agent/${node.name}`)}
    class:former={node.entry.status === 'destroyed'}
    href="/sessions/agent/{node.name}"
  >
    <span class="item-icon">{typeIcon(node.entry.type)}</span>
    <span class="item-name">{node.name}</span>
    {#if node.currentSessionStart}
      {#if node.entry.status === 'destroyed'}
        <span class="item-date">{fmtDate(node.currentSessionStart)}</span>
      {:else}
        <span class="item-date">{formatDateOpen(node.currentSessionStart)}</span>
      {/if}
    {/if}
    <span class="item-dot {statusClass(getLiveStatus(node.name) ?? node.entry.status)}">{statusDot(getLiveStatus(node.name) ?? node.entry.status)}</span>
  </a>

  {#if showHistory && node.formerSessions.length > 0}
    {#each node.formerSessions as session}
      <a
        class="sidebar-item former depth-{depth}"
        class:active={isActive(`/sessions/agent/${node.name}/${session.sessionId}`)}
        href="/sessions/agent/{node.name}/{session.sessionId}"
      >
        <span class="item-icon-spacer"></span>
        <span class="item-name">{node.name}</span>
        <span class="item-date">{formatDateRange(session.firstAt, session.lastAt)}</span>
        <span class="item-dot status-destroyed">◌</span>
      </a>
    {/each}
  {/if}

  {#if node.children.length > 0}
    {@const visibleChildren = node.children.filter(c => c.entry.status !== 'destroyed' || showHistory)}
    {#if visibleChildren.length > 0 && node.entry.type === 'orchestrator'}
      <div class="sidebar-group-label">BUILDERS</div>
    {/if}
    {#each visibleChildren as child}
      {@render agentNode(child, depth + 1)}
    {/each}
  {/if}
{/snippet}

<style>
  .sessions-layout {
    display: flex;
    gap: 1rem;
    height: calc(100vh - 4.5rem);
    margin: -1.5rem;
    padding: 1rem 1.5rem 1rem;
  }

  .sidebar {
    width: 280px;
    min-width: 280px;
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

  .sidebar-content {
    flex: 1;
    padding: 0.5rem 0;
    overflow-y: auto;
  }

  .sidebar-group-label {
    padding: 0.75rem 1rem 0.25rem;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-tertiary);
  }

  .sidebar-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 1rem;
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
  .sidebar-item.former {
    opacity: 0.5;
  }

  .sidebar-item.depth-1 { padding-left: 2rem; }
  .sidebar-item.depth-2 { padding-left: 3rem; }

  .item-icon { font-size: 0.85rem; flex-shrink: 0; width: 1.1rem; text-align: center; }
  .item-icon-spacer { width: 1.1rem; flex-shrink: 0; }
  .item-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item-date { font-size: 0.65rem; color: var(--text-tertiary); white-space: nowrap; }
  .item-dot { flex-shrink: 0; font-size: 0.6rem; }

  .status-active { color: var(--status-ok); }
  .status-idle { color: var(--text-tertiary); }
  .status-destroyed { color: var(--text-tertiary); }

  .sidebar-footer {
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .live-indicator {
    text-align: center;
  }

  .live-dot {
    font-size: 0.7rem;
    font-weight: 500;
  }
  .live-dot.connected { color: var(--status-ok, #34d399); }
  .live-dot.disconnected { color: var(--text-tertiary); }

  .history-toggle {
    width: 100%;
    padding: 0.4rem;
    font-size: 0.75rem;
    color: var(--text-tertiary);
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .history-toggle:hover {
    color: var(--text-secondary);
    border-color: var(--border-primary);
  }

  .content {
    flex: 1;
    overflow: hidden;
    padding: 0.5rem 1rem;
    display: flex;
    flex-direction: column;
  }
</style>
