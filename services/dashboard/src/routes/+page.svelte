<script lang="ts">
  import { Tooltip } from "bits-ui";
  import { getDataVersion } from '$lib/events.svelte';
  import { invalidateAll } from '$app/navigation';
  import ActivityGrid from '$lib/ActivityGrid.svelte';

  let { data } = $props();

  // Re-fetch server data when SSE events arrive
  let lastVersion = $state(getDataVersion());
  $effect(() => {
    const v = getDataVersion();
    if (v !== lastVersion) {
      lastVersion = v;
      invalidateAll();
    }
  });

  // Compute usage stats
  const entries = $derived(data.usageEntries);
  const now = Date.now();
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;

  function sumEntries(list: (typeof data.usageEntries)) {
    let cost = 0, inputRaw = 0, output = 0, cacheCreation = 0, cacheRead = 0, duration = 0;
    for (const e of list) {
      cost += e.costUsd ?? 0;
      inputRaw += e.inputTokens;
      output += e.outputTokens;
      cacheCreation += e.cacheCreationTokens;
      cacheRead += e.cacheReadTokens;
      duration += e.durationMs ?? 0;
    }
    // Total input = non-cached + cache creation + cache read
    const input = inputRaw + cacheCreation + cacheRead;
    const cacheTotal = cacheCreation + cacheRead;
    return {
      turns: list.length, cost, input, output, cacheCreation, cacheRead, duration,
      cacheRate: cacheTotal > 0 ? Math.round((cacheRead / cacheTotal) * 100) : 0,
      avgCost: list.length > 0 ? cost / list.length : 0,
    };
  }

  const todayEntries = $derived(entries.filter(e => new Date(e.timestamp).getTime() >= todayStart));
  const weekEntries = $derived(entries.filter(e => new Date(e.timestamp).getTime() >= weekStart));

  const allStats = $derived(sumEntries(entries));
  const todayStats = $derived(sumEntries(todayEntries));
  const weekStats = $derived(sumEntries(weekEntries));

  // Daily cost stacked by model + token breakdown
  const { dailyCost, maxDailyCost, maxDailyTokens, models, modelColors } = $derived.by(() => {
    const dailyMap = new Map<string, { costByModel: Map<string, number>; inputUncached: number; inputCached: number; output: number }>();
    const modelSet = new Set<string>();
    for (const e of entries) {
      const day = new Date(e.timestamp).toLocaleDateString('en-CA'); // YYYY-MM-DD in local tz
      const model = e.model ?? 'unknown';
      modelSet.add(model);
      if (!dailyMap.has(day)) dailyMap.set(day, { costByModel: new Map(), inputUncached: 0, inputCached: 0, output: 0 });
      const d = dailyMap.get(day)!;
      d.costByModel.set(model, (d.costByModel.get(model) ?? 0) + (e.costUsd ?? 0));
      d.inputUncached += e.inputTokens + e.cacheCreationTokens;
      d.inputCached += e.cacheReadTokens;
      d.output += e.outputTokens;
    }
    const models = [...modelSet].sort();
    const dailyCost = [...dailyMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, d]) => ({
        day,
        totalCost: [...d.costByModel.values()].reduce((s, v) => s + v, 0),
        costByModel: Object.fromEntries(d.costByModel),
        inputUncached: d.inputUncached,
        inputCached: d.inputCached,
        output: d.output,
        totalTokens: d.inputUncached + d.inputCached + d.output,
      }));
    const maxDailyCost = Math.max(...dailyCost.map(d => d.totalCost), 0.01);
    const maxDailyTokens = Math.max(...dailyCost.map(d => d.totalTokens), 1);
    const palette = [
      'var(--chart-bar, #60a5fa)',
      'var(--chart-cache, #34d399)',
      '#f472b6',
      '#fbbf24',
      '#a78bfa',
      '#fb923c',
    ];
    const modelColors: Record<string, string> = {};
    models.forEach((m, i) => { modelColors[m] = palette[i % palette.length]; });
    return { dailyCost, maxDailyCost, maxDailyTokens, models, modelColors };
  });

  // Helpers
  function fmtCost(n: number) { return `$${n.toFixed(4)}`; }
  function fmtDuration(ms: number) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m ${rs}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  function fmtAge(iso: string) {
    const diff = now - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }
  function fmtTokens(n: number) { return n.toLocaleString(); }

  // Agent costs (computed server-side, with transcript-based estimates as fallback)
  const agentCosts = $derived(data.agentCosts as Record<string, { cost: number; estimated: boolean }> ?? {});

  // Agent registry
  const allAgents = $derived(Object.entries(data.agents)
    .map(([name, entry]: [string, any]) => ({
      name,
      type: entry.type as string,
      status: entry.status as string,
      parent: entry.parent as string | undefined,
      workspace: entry.workspace as string | undefined,
      epicId: entry.epicId as string | undefined,
      taskId: entry.taskId as string | undefined,
      children: (entry.children as string[] | undefined) ?? [],
      createdAt: entry.createdAt as string,
    }))
    .sort((a, b) => {
      const typeOrder: Record<string, number> = { orchestrator: 0, builder: 1, helper: 2 };
      return (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3);
    }));

  // Partition agents: active/idle, recently destroyed (<1h), older destroyed
  const ONE_HOUR = 60 * 60 * 1000;
  const liveAgents = $derived(allAgents.filter(a => a.status !== 'destroyed'));
  const destroyedAgents = $derived(allAgents.filter(a => a.status === 'destroyed'));
  const recentlyDestroyed = $derived(destroyedAgents.filter(
    a => now - new Date(a.createdAt).getTime() < ONE_HOUR
  ));
  const olderDestroyed = $derived(destroyedAgents.filter(
    a => now - new Date(a.createdAt).getTime() >= ONE_HOUR
  ));
  const agentList = $derived([...liveAgents, ...recentlyDestroyed]);
  const activeAgentCount = $derived(liveAgents.filter(a => a.status === 'active').length);
  let showAllDestroyed = $state(false);
  const displayAgents = $derived(showAllDestroyed ? [...agentList, ...olderDestroyed] : agentList);

  function agentTypeIcon(type: string) {
    switch (type) {
      case 'orchestrator': return '\u{1F451}';
      case 'builder': return '\u{1F528}';
      case 'helper': return '\u{26A1}';
      default: return '\u{1F4AD}';
    }
  }

  // State file tabs
  const stateFiles = $derived(data.stateFiles ?? []);
  let activeFileTab = $state(0);
  const activeFile = $derived(stateFiles[activeFileTab]);

</script>

<svelte:head>
  <title>Friday Dashboard</title>
</svelte:head>

<div class="dashboard">
  <!-- Stats Row -->
  <div class="stats-row">
    <div class="card stat-card">
      <div class="stat">
        <span class="stat-label">Today</span>
        <span class="stat-value">{fmtCost(todayStats.cost)}</span>
        <span class="stat-detail">{todayStats.turns} turns &middot; avg {fmtCost(todayStats.avgCost)}</span>
      </div>
    </div>
    <div class="card stat-card">
      <div class="stat">
        <span class="stat-label">This Week</span>
        <span class="stat-value">{fmtCost(weekStats.cost)}</span>
        <span class="stat-detail">{weekStats.turns} turns &middot; avg {fmtCost(weekStats.avgCost)}</span>
      </div>
    </div>
    <div class="card stat-card">
      <div class="stat">
        <span class="stat-label">Cache Hit Rate</span>
        <span class="stat-value">{allStats.cacheRate}%</span>
        <span class="stat-detail">{fmtTokens(allStats.cacheRead)} / {fmtTokens(allStats.cacheRead + allStats.cacheCreation)} tokens</span>
      </div>
    </div>
    <div class="card stat-card">
      <div class="stat">
        <span class="stat-label">Agent Time</span>
        <span class="stat-value">{fmtDuration(allStats.duration)}</span>
        <span class="stat-detail">{allStats.turns} total turns</span>
      </div>
    </div>
  </div>

  <!-- Activity Grid -->
  <div class="card activity-card">
    <div class="card-header">
      <h2>Activity</h2>
      <span class="stat-detail">Orchestrator turns in the last year</span>
    </div>
    <ActivityGrid activityByDate={data.activityByDate} />
  </div>

  <!-- Main Grid -->
  <div class="main-grid">
    <!-- Daily Cost Chart -->
    <div class="card chart-card">
      <div class="card-header">
        <h2>Daily Cost</h2>
        <span class="stat-detail">{dailyCost.length} days</span>
      </div>
      <div class="chart-legend">
        {#each models as model}
          <span class="legend-item">
            <span class="legend-swatch" style="background: {modelColors[model]}"></span>
            {model}
          </span>
        {/each}
        <span class="legend-sep"></span>
        <span class="legend-item">
          <span class="legend-swatch" style="background: var(--chart-input, #818cf8)"></span>
          input
        </span>
        <span class="legend-item">
          <span class="legend-swatch" style="background: var(--chart-input-cached, #a5b4fc)"></span>
          cached
        </span>
        <span class="legend-item">
          <span class="legend-swatch" style="background: var(--chart-output, #f59e0b)"></span>
          output
        </span>
      </div>
      <Tooltip.Provider delayDuration={150}>
      <div class="bar-chart">
        {#each dailyCost as day}
          <div class="day-group">
            <span class="bar-label">{day.day.slice(5)}</span>
            <div class="day-bars">
              <div class="day-bar-row">
                <div class="bar-track">
                  {#each models as model}
                    {@const seg = day.costByModel[model] ?? 0}
                    {#if seg > 0}
                      <Tooltip.Root>
                        <Tooltip.Trigger
                          class="bar-fill-segment"
                          style="width: {(seg / maxDailyCost) * 100}%; background: {modelColors[model]}"
                        />
                        <Tooltip.Portal>
                          <Tooltip.Content class="segment-tooltip" sideOffset={6}>
                            <span class="segment-tooltip-label">{model}</span>
                            <span class="segment-tooltip-value">{fmtCost(seg)}</span>
                          </Tooltip.Content>
                        </Tooltip.Portal>
                      </Tooltip.Root>
                    {/if}
                  {/each}
                </div>
                <span class="bar-value">{fmtCost(day.totalCost)}</span>
              </div>
              <div class="day-bar-row token-row">
                <div class="bar-track">
                  {#if day.inputUncached > 0}
                    <Tooltip.Root>
                      <Tooltip.Trigger
                        class="bar-fill-segment"
                        style="width: {(day.inputUncached / maxDailyTokens) * 100}%; background: var(--chart-input, #818cf8)"
                      />
                      <Tooltip.Portal>
                        <Tooltip.Content class="segment-tooltip" sideOffset={6}>
                          <span class="segment-tooltip-label">Input</span>
                          <span class="segment-tooltip-value">{fmtTokens(day.inputUncached)}</span>
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  {/if}
                  {#if day.inputCached > 0}
                    <Tooltip.Root>
                      <Tooltip.Trigger
                        class="bar-fill-segment"
                        style="width: {(day.inputCached / maxDailyTokens) * 100}%; background: var(--chart-input-cached, #a5b4fc)"
                      />
                      <Tooltip.Portal>
                        <Tooltip.Content class="segment-tooltip" sideOffset={6}>
                          <span class="segment-tooltip-label">Cached</span>
                          <span class="segment-tooltip-value">{fmtTokens(day.inputCached)}</span>
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  {/if}
                  {#if day.output > 0}
                    <Tooltip.Root>
                      <Tooltip.Trigger
                        class="bar-fill-segment"
                        style="width: {(day.output / maxDailyTokens) * 100}%; background: var(--chart-output, #f59e0b)"
                      />
                      <Tooltip.Portal>
                        <Tooltip.Content class="segment-tooltip" sideOffset={6}>
                          <span class="segment-tooltip-label">Output</span>
                          <span class="segment-tooltip-value">{fmtTokens(day.output)}</span>
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  {/if}
                </div>
                <span class="bar-value">{fmtTokens(day.totalTokens)}</span>
              </div>
            </div>
          </div>
        {/each}
        {#if dailyCost.length === 0}
          <p class="empty-state">No usage data yet</p>
        {/if}
      </div>
      </Tooltip.Provider>
    </div>

    <!-- Token Breakdown -->
    <div class="card">
      <div class="card-header">
        <h2>Token Breakdown</h2>
        <span class="stat-detail">All time</span>
      </div>
      <div class="token-grid">
        <div class="token-item">
          <span class="token-label">Input</span>
          <span class="token-value">{fmtTokens(allStats.input)}</span>
        </div>
        <div class="token-item">
          <span class="token-label">Output</span>
          <span class="token-value">{fmtTokens(allStats.output)}</span>
        </div>
        <div class="token-item">
          <span class="token-label">Cache Creation</span>
          <span class="token-value">{fmtTokens(allStats.cacheCreation)}</span>
        </div>
        <div class="token-item accent">
          <span class="token-label">Cache Read</span>
          <span class="token-value">{fmtTokens(allStats.cacheRead)}</span>
        </div>
      </div>

      <!-- Cache ratio bar -->
      <div class="cache-bar">
        <div class="cache-bar-label">Cache efficiency</div>
        <div class="cache-bar-track">
          <div class="cache-bar-read" style="width: {allStats.cacheRate}%"></div>
        </div>
        <div class="cache-bar-pct">{allStats.cacheRate}%</div>
      </div>
    </div>

    <!-- Agents -->
    <div class="card agents-card">
      <div class="card-header">
        <h2>Agents</h2>
        <span class="stat-detail">
          {activeAgentCount} active{#if olderDestroyed.length > 0}
            <button class="toggle-link" onclick={() => showAllDestroyed = !showAllDestroyed}>
              {showAllDestroyed ? 'Hide' : 'Show'} {olderDestroyed.length} deleted
            </button>
          {/if}
        </span>
      </div>
      {#if displayAgents.length === 0}
        <p class="empty-state">No agents registered</p>
      {:else}
        <table class="data-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Type</th>
              <th>Status</th>
              <th>Cost</th>
              <th>Parent</th>
              <th>Epic/Task</th>
              <th>Children</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {#each displayAgents as agent}
              <tr class:destroyed={agent.status === 'destroyed'}>
                <td class="agent-name">{agent.name}</td>
                <td>
                  <span class="agent-type-badge" data-type={agent.type}>
                    {agentTypeIcon(agent.type)} {agent.type}
                  </span>
                </td>
                <td>
                  <span class="badge" class:ok={agent.status === 'active'} class:warn={agent.status === 'idle'} class:err={agent.status === 'destroyed'}>
                    {agent.status}
                  </span>
                </td>
                <td class="text-mono">
                  {#if agentCosts[agent.name]}
                    {fmtCost(agentCosts[agent.name].cost)}{#if agentCosts[agent.name].estimated}<span class="estimated-badge" title="Estimated from transcript token counts">~</span>{/if}
                  {:else}
                    &mdash;
                  {/if}
                </td>
                <td class="text-muted">{agent.parent ?? '\u2014'}</td>
                <td class="text-mono">{agent.epicId ?? agent.taskId ?? '\u2014'}</td>
                <td class="text-muted">{agent.children.length > 0 ? agent.children.join(', ') : '\u2014'}</td>
                <td>{fmtAge(agent.createdAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <!-- Config -->
    <div class="card config-card">
      <div class="card-header">
        <h2>Files</h2>
        <div class="file-tabs">
          {#each stateFiles as file, i}
            <button
              class="file-tab"
              class:active={activeFileTab === i}
              class:missing={file.content == null}
              onclick={() => activeFileTab = i}
            >
              {file.label}
            </button>
          {/each}
        </div>
      </div>
      <div class="config-path">{activeFile?.path ?? ''}</div>
      {#if activeFile?.content != null}
        <pre class="code-block"><code>{activeFile.content}</code></pre>
      {:else}
        <p class="empty-state">File not found</p>
      {/if}
    </div>
  </div>
</div>

<style>
  .dashboard {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* Stats Row */
  .stats-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
  }

  .stat-card {
    padding: 1rem 1.25rem;
  }

  /* Activity Grid */
  .activity-card {
    padding: 1rem 1.25rem;
  }

  /* Main Grid */
  .main-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    min-width: 0;
    align-items: stretch;
  }

  .main-grid > :global(*) {
    min-width: 0;
  }

  .chart-card {
    display: flex;
    flex-direction: column;
  }

  .chart-card .bar-chart {
    flex: 1;
    min-height: 0;
  }

  .agents-card,
  .config-card {
    grid-column: 1 / -1;
  }

  .agent-name {
    font-family: var(--font-mono);
    font-weight: 600;
  }

  .agent-type-badge {
    font-size: 0.8rem;
    white-space: nowrap;
  }

  .text-muted {
    color: var(--text-tertiary);
    font-size: 0.85rem;
  }

  .text-mono {
    font-family: var(--font-mono);
    font-size: 0.8rem;
  }

  tr.destroyed {
    opacity: 0.4;
  }

  .estimated-badge {
    color: var(--text-tertiary);
    font-size: 0.75rem;
    margin-left: 0.15rem;
  }

  .toggle-link {
    background: none;
    border: none;
    color: var(--accent, #3b82f6);
    cursor: pointer;
    font-size: inherit;
    padding: 0;
    margin-left: 0.5rem;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .toggle-link:hover {
    opacity: 0.8;
  }

  .badge.err {
    background: var(--error, #ef4444);
    color: white;
  }

  /* Bar chart — ~10 rows visible */
  .bar-chart {
    max-height: 16rem;
    overflow-y: auto;
  }

  :global(.bar-fill-segment) {
    height: 100%;
    flex-shrink: 0;
    border-radius: 0;
    border: none;
    padding: 0;
    cursor: default;
    appearance: none;
    display: block;
  }

  :global(.bar-fill-segment:first-child) {
    border-radius: 3px 0 0 3px;
  }

  :global(.bar-fill-segment:last-child) {
    border-radius: 0 3px 3px 0;
  }

  :global(.bar-fill-segment:only-child) {
    border-radius: 3px;
  }

  .chart-card .bar-track {
    display: flex;
  }

  :global(.segment-tooltip) {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.1rem;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    padding: 0.35rem 0.5rem;
    white-space: nowrap;
    z-index: 50;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  :global(.segment-tooltip-label) {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
  }

  :global(.segment-tooltip-value) {
    font-family: var(--font-mono);
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .day-group {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.6rem;
  }

  .day-group .bar-label {
    align-self: flex-start;
    padding-top: 0.15rem;
  }

  .day-bars {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.075rem;
  }

  .day-bar-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .day-bar-row .bar-track {
    flex: 1;
    min-width: 0;
    display: flex;
    height: 1.1rem;
    background: var(--bg-tertiary);
    border-radius: 3px;
    overflow: hidden;
  }

  .token-row .bar-track {
    height: 0.6rem;
  }

  .legend-sep {
    width: 1px;
    height: 0.8rem;
    background: var(--border-primary);
    margin: 0 0.25rem;
  }

  .chart-legend {
    display: flex;
    gap: 1rem;
    padding: 0 0 0.5rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .legend-swatch {
    display: inline-block;
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 2px;
  }

  /* Token grid */
  .token-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
  }

  .token-item {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.6rem 0.75rem;
    background: var(--bg-secondary);
    border-radius: var(--radius-sm);
  }

  .token-item.accent {
    background: var(--accent-glow);
  }

  .token-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
  }

  .token-value {
    font-family: var(--font-mono);
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  /* Cache bar */
  .cache-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .cache-bar-label {
    font-size: 0.75rem;
    color: var(--text-tertiary);
    min-width: 7rem;
  }

  .cache-bar-track {
    flex: 1;
    height: 0.5rem;
    background: var(--bg-tertiary);
    border-radius: 3px;
    overflow: hidden;
  }

  .cache-bar-read {
    height: 100%;
    background: var(--chart-cache);
    border-radius: 3px;
    transition: width var(--transition-normal);
  }

  .cache-bar-pct {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--text-secondary);
    min-width: 2.5rem;
    text-align: right;
  }

  /* Config */
  .config-path {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--text-tertiary);
    margin-bottom: 0.75rem;
  }

  .config-card pre.code-block {
    height: 16rem;
    overflow-y: auto;
  }

  .file-tabs {
    display: flex;
    gap: 0.25rem;
  }

  .file-tab {
    padding: 0.2rem 0.6rem;
    font-size: 0.75rem;
    font-family: var(--font-mono);
    color: var(--text-tertiary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .file-tab:hover {
    color: var(--text-secondary);
    background: var(--bg-tertiary);
  }
  .file-tab.active {
    color: var(--accent-primary);
    background: var(--accent-glow);
    border-color: var(--accent-primary);
  }
  .file-tab.missing {
    opacity: 0.4;
  }
  .file-tab.missing.active {
    opacity: 1;
  }

  /* Empty state */
  .empty-state {
    text-align: center;
    padding: 2rem;
    color: var(--text-tertiary);
    font-size: 0.85rem;
  }

  /* Responsive */
  @media (max-width: 768px) {
    .stats-row {
      grid-template-columns: repeat(2, 1fr);
    }

    .main-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
