<script lang="ts">
  import { Tooltip } from "bits-ui";

  let { data } = $props();

  // Compute usage stats
  const entries = data.usageEntries;
  const now = Date.now();
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;

  function sumEntries(list: typeof entries) {
    let cost = 0, inputRaw = 0, output = 0, cacheCreation = 0, cacheRead = 0, duration = 0;
    for (const e of list) {
      cost += e.costUsd ?? 0;
      inputRaw += e.inputTokens;
      output += e.outputTokens;
      cacheCreation += e.cacheCreationTokens;
      cacheRead += e.cacheReadTokens;
      duration += e.durationMs;
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

  const todayEntries = entries.filter(e => new Date(e.timestamp).getTime() >= todayStart);
  const weekEntries = entries.filter(e => new Date(e.timestamp).getTime() >= weekStart);

  const allStats = sumEntries(entries);
  const todayStats = sumEntries(todayEntries);
  const weekStats = sumEntries(weekEntries);

  // Session aggregates
  const parentMap = data.sessionParentMap ?? {};
  const sessionMap = new Map<string, { type: string; turns: number; cost: number; lastAt: string }>();
  for (const e of entries) {
    const existing = sessionMap.get(e.sessionId);
    if (existing) {
      existing.turns++;
      existing.cost += e.costUsd ?? 0;
      existing.lastAt = e.timestamp;
    } else {
      sessionMap.set(e.sessionId, {
        type: e.sessionType,
        turns: 1,
        cost: e.costUsd ?? 0,
        lastAt: e.timestamp,
      });
    }
  }
  const sessionList = [...sessionMap.entries()]
    .map(([id, s]) => {
      const parent = parentMap[id];
      return {
        id, ...s,
        parentLabel: parent?.label ?? '\u2014',
        parentKind: parent?.kind ?? 'channel',
        active: parent?.active ?? false,
      };
    })
    .sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());

  // Daily cost stacked by model + token breakdown
  const dailyMap = new Map<string, { costByModel: Map<string, number>; inputUncached: number; inputCached: number; output: number }>();
  const modelSet = new Set<string>();
  for (const e of entries) {
    const day = e.timestamp.slice(0, 10);
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

  // Model colors — deterministic palette
  const modelColors: Record<string, string> = {};
  const palette = [
    'var(--chart-bar, #60a5fa)',
    'var(--chart-cache, #34d399)',
    '#f472b6',
    '#fbbf24',
    '#a78bfa',
    '#fb923c',
  ];
  models.forEach((m, i) => { modelColors[m] = palette[i % palette.length]; });

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

  // Agent registry
  const allAgents = Object.entries(data.agents)
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
      const typeOrder: Record<string, number> = { orchestrator: 0, builder: 1, agent: 2 };
      return (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3);
    });

  // Partition agents: active/idle, recently destroyed (<1h), older destroyed
  const ONE_HOUR = 60 * 60 * 1000;
  const liveAgents = allAgents.filter(a => a.status !== 'destroyed');
  const destroyedAgents = allAgents.filter(a => a.status === 'destroyed');
  const recentlyDestroyed = destroyedAgents.filter(
    a => now - new Date(a.createdAt).getTime() < ONE_HOUR
  );
  const olderDestroyed = destroyedAgents.filter(
    a => now - new Date(a.createdAt).getTime() >= ONE_HOUR
  );
  const agentList = [...liveAgents, ...recentlyDestroyed];
  const activeAgentCount = liveAgents.filter(a => a.status === 'active').length;
  let showAllDestroyed = $state(false);
  const displayAgents = $derived(showAllDestroyed ? [...agentList, ...olderDestroyed] : agentList);

  function agentTypeIcon(type: string) {
    switch (type) {
      case 'orchestrator': return '\u{1F451}';
      case 'builder': return '\u{1F528}';
      case 'agent': return '\u{26A1}';
      default: return '\u{1F4AD}';
    }
  }

  // Memory entries
  const memories = data.memories ?? [];
  const memoriesSorted = [...memories].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  let showAllMemories = $state(false);
  const MEMORY_PREVIEW_COUNT = 10;
  const displayMemories = $derived(
    showAllMemories ? memoriesSorted : memoriesSorted.slice(0, MEMORY_PREVIEW_COUNT)
  );
</script>

<svelte:head>
  <title>Friday Dashboard</title>
</svelte:head>

<div class="dashboard">
  <!-- Status Bar -->
  <div class="status-bar card">
    <div class="status-left">
      <span class="pulse" class:offline={!data.daemonOnline}></span>
      <span class="status-text">
        {#if data.daemonOnline}
          Online
          {#if data.health}
            &middot; PID {data.health.pid} &middot; up {fmtDuration(data.health.uptimeMs)}
          {/if}
        {:else}
          Offline
        {/if}
      </span>
    </div>
    <div class="status-right">
      <span class="badge" class:ok={data.configExists} class:warn={!data.configExists}>
        {data.configExists ? 'Config loaded' : 'Using defaults'}
      </span>
    </div>
  </div>

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

    <!-- Sessions -->
    <div class="card sessions-card">
      <div class="card-header">
        <h2>Sessions</h2>
        <span class="stat-detail">{sessionList.length} total</span>
      </div>
      {#if sessionList.length === 0}
        <p class="empty-state">No sessions yet</p>
      {:else}
        <table class="data-table">
          <thead>
            <tr>
              <th>Session</th>
              <th>Type</th>
              <th>Parent</th>
              <th>Turns</th>
              <th>Cost</th>
              <th>Last Active</th>
            </tr>
          </thead>
          <tbody>
            {#each sessionList as session}
              <tr class:past-session={!session.active}>
                <td>{session.id.slice(0, 8)}&hellip;</td>
                <td>
                  <span class="badge" class:ok={session.type === 'orchestrator'} class:warn={session.type !== 'orchestrator'}>
                    {session.type}
                  </span>
                </td>
                <td>
                  <span class="session-parent" data-kind={session.parentKind}>
                    {session.parentLabel}
                  </span>
                </td>
                <td>{session.turns}</td>
                <td>{fmtCost(session.cost)}</td>
                <td>{fmtAge(session.lastAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <!-- Memory -->
    <div class="card memory-card">
      <div class="card-header">
        <h2>Memory</h2>
        <span class="stat-detail">
          {memories.length} entries{#if memories.length > MEMORY_PREVIEW_COUNT}
            <button class="toggle-link" onclick={() => showAllMemories = !showAllMemories}>
              {showAllMemories ? 'Show less' : `Show all ${memories.length}`}
            </button>
          {/if}
        </span>
      </div>
      {#if memories.length === 0}
        <p class="empty-state">No memories stored yet</p>
      {:else}
        <div class="memory-list">
          {#each displayMemories as mem}
            <div class="memory-item">
              <div class="memory-header">
                <span class="memory-title">{mem.title}</span>
                <span class="memory-meta">
                  by {mem.createdBy} &middot; recalled {mem.recallCount}x &middot; {fmtAge(mem.updatedAt)}
                </span>
              </div>
              {#if mem.tags.length > 0}
                <div class="memory-tags">
                  {#each mem.tags as tag}
                    <span class="memory-tag">{tag}</span>
                  {/each}
                </div>
              {/if}
              <div class="memory-content">{mem.content.slice(0, 150)}{mem.content.length > 150 ? '...' : ''}</div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Config -->
    <div class="card config-card">
      <div class="card-header">
        <h2>Configuration</h2>
        <span class="badge" class:ok={data.configExists} class:warn={!data.configExists}>
          {data.configExists ? 'loaded' : 'defaults'}
        </span>
      </div>
      <div class="config-path">{data.configPath}</div>
      <pre class="code-block"><code>{JSON.stringify(data.config, null, 2)}</code></pre>
    </div>
  </div>
</div>

<style>
  .dashboard {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* Status Bar */
  .status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 1rem;
  }

  .status-left {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .status-text {
    font-family: var(--font-mono);
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .status-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
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
  .sessions-card,
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

  tr.past-session {
    opacity: 0.5;
  }

  .session-parent {
    font-size: 0.85rem;
    font-family: var(--font-mono);
  }

  .session-parent[data-kind="agent"] {
    color: var(--text-secondary);
  }

  .session-parent[data-kind="channel"] {
    color: var(--text-tertiary);
  }

  .session-parent[data-kind="dm"] {
    color: var(--text-tertiary);
    font-style: italic;
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

  /* Memory */
  .memory-card {
    grid-column: 1 / -1;
  }

  .memory-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .memory-item {
    padding: 0.6rem 0.75rem;
    background: var(--bg-secondary);
    border-radius: var(--radius-sm);
  }

  .memory-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
  }

  .memory-title {
    font-weight: 600;
    font-size: 0.9rem;
    color: var(--text-primary);
  }

  .memory-meta {
    font-size: 0.7rem;
    color: var(--text-tertiary);
    white-space: nowrap;
  }

  .memory-tags {
    display: flex;
    gap: 0.3rem;
    margin-top: 0.25rem;
  }

  .memory-tag {
    font-size: 0.65rem;
    padding: 0.1rem 0.4rem;
    background: var(--bg-tertiary);
    border-radius: 3px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }

  .memory-content {
    margin-top: 0.3rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  /* Config */
  .config-path {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--text-tertiary);
    margin-bottom: 0.75rem;
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
