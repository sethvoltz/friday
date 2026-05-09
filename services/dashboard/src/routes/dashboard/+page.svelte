<script lang="ts">
  import { Tooltip } from "bits-ui";
  import { invalidateAll } from "$app/navigation";
  import { dashboardData } from "$lib/stores/dashboard-data.svelte";
  import ActivityGrid from "$lib/components/Dashboard/ActivityGrid.svelte";
  import Toggle from "$lib/components/Toggle/Toggle.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let lastVersion = $state(dashboardData.version);
  $effect(() => {
    const v = dashboardData.version;
    if (v !== lastVersion) {
      lastVersion = v;
      void invalidateAll();
    }
  });

  const entries = $derived(data.usageEntries);
  const now = Date.now();
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;

  function sumEntries(list: typeof data.usageEntries) {
    let cost = 0,
      inputRaw = 0,
      output = 0,
      cacheCreation = 0,
      cacheRead = 0,
      duration = 0;
    for (const e of list) {
      cost += e.costUsd ?? 0;
      inputRaw += e.inputTokens;
      output += e.outputTokens;
      cacheCreation += e.cacheCreationTokens;
      cacheRead += e.cacheReadTokens;
      duration += e.durationMs ?? 0;
    }
    const input = inputRaw + cacheCreation + cacheRead;
    const cacheTotal = cacheCreation + cacheRead;
    return {
      turns: list.length,
      cost,
      input,
      output,
      cacheCreation,
      cacheRead,
      duration,
      cacheRate: cacheTotal > 0 ? Math.round((cacheRead / cacheTotal) * 100) : 0,
      avgCost: list.length > 0 ? cost / list.length : 0,
    };
  }

  const todayEntries = $derived(
    entries.filter((e) => new Date(e.timestamp).getTime() >= todayStart),
  );
  const weekEntries = $derived(
    entries.filter((e) => new Date(e.timestamp).getTime() >= weekStart),
  );
  const allStats = $derived(sumEntries(entries));
  const todayStats = $derived(sumEntries(todayEntries));
  const weekStats = $derived(sumEntries(weekEntries));

  const {
    dailyCost,
    maxDailyCost,
    maxDailyTokens,
    maxDailyTokensNoCached,
    models,
    modelColors,
  } = $derived.by(() => {
    const dailyMap = new Map<
      string,
      {
        costByModel: Map<string, number>;
        inputUncached: number;
        inputCached: number;
        output: number;
      }
    >();
    const modelSet = new Set<string>();
    for (const e of entries) {
      const day = new Date(e.timestamp).toLocaleDateString("en-CA");
      const model = e.model ?? "unknown";
      modelSet.add(model);
      if (!dailyMap.has(day))
        dailyMap.set(day, {
          costByModel: new Map(),
          inputUncached: 0,
          inputCached: 0,
          output: 0,
        });
      const d = dailyMap.get(day)!;
      d.costByModel.set(
        model,
        (d.costByModel.get(model) ?? 0) + (e.costUsd ?? 0),
      );
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
    const maxDailyCost = Math.max(...dailyCost.map((d) => d.totalCost), 0.01);
    const maxDailyTokens = Math.max(...dailyCost.map((d) => d.totalTokens), 1);
    const maxDailyTokensNoCached = Math.max(
      ...dailyCost.map((d) => d.inputUncached + d.output),
      1,
    );
    const palette = [
      "var(--chart-1, #60a5fa)",
      "var(--chart-cache, #34d399)",
      "#f472b6",
      "#fbbf24",
      "#a78bfa",
      "#fb923c",
    ];
    const modelColors: Record<string, string> = {};
    models.forEach((m, i) => {
      modelColors[m] = palette[i % palette.length];
    });
    return {
      dailyCost,
      maxDailyCost,
      maxDailyTokens,
      maxDailyTokensNoCached,
      models,
      modelColors,
    };
  });

  function dayKey(d: Date): string {
    return d.toLocaleDateString("en-CA");
  }
  function weekKey(d: Date): string {
    const day = d.getDay() || 7;
    const monday = new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate() - day + 1,
    );
    return dayKey(monday);
  }
  function monthKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  function mean(values: number[]): number {
    return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  }
  function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  const nowDate = new Date();
  const todayKey = dayKey(nowDate);
  const thisWeekKey = weekKey(nowDate);
  const thisMonthKey = monthKey(nowDate);

  type TokenStats = {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
    cost: number;
  };
  function emptyStats(): TokenStats {
    return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0 };
  }

  const buckets = $derived.by(() => {
    const day = new Map<string, TokenStats>();
    const week = new Map<string, TokenStats>();
    const month = new Map<string, TokenStats>();
    const upsert = (
      m: Map<string, TokenStats>,
      k: string,
      e: (typeof entries)[number],
    ) => {
      let b = m.get(k);
      if (!b) {
        b = emptyStats();
        m.set(k, b);
      }
      b.input += e.inputTokens + e.cacheCreationTokens + e.cacheReadTokens;
      b.output += e.outputTokens;
      b.cacheCreation += e.cacheCreationTokens;
      b.cacheRead += e.cacheReadTokens;
      b.cost += e.costUsd ?? 0;
    };
    for (const e of entries) {
      const d = new Date(e.timestamp);
      upsert(day, dayKey(d), e);
      upsert(week, weekKey(d), e);
      upsert(month, monthKey(d), e);
    }
    return { day, week, month };
  });

  type Period = "day" | "week" | "month";
  const PERIODS: Period[] = ["day", "week", "month"];
  let tokenPeriod = $state<Period>("day");
  const periodLabels: Record<Period, string> = {
    day: "Today",
    week: "This Week",
    month: "This Month",
  };
  const periodCurrentKey: Record<Period, string> = {
    day: todayKey,
    week: thisWeekKey,
    month: thisMonthKey,
  };

  const tokenView = $derived.by(() => {
    const map = buckets[tokenPeriod];
    const current = map.get(periodCurrentKey[tokenPeriod]) ?? emptyStats();
    const all = [...map.values()];
    const aggs = (key: keyof TokenStats) => {
      const values = all.map((b) => b[key]);
      return { mean: mean(values), median: median(values) };
    };
    const cacheTotal = current.cacheCreation + current.cacheRead;
    return {
      input: { value: current.input, ...aggs("input") },
      output: { value: current.output, ...aggs("output") },
      cacheCreation: {
        value: current.cacheCreation,
        ...aggs("cacheCreation"),
      },
      cacheRead: { value: current.cacheRead, ...aggs("cacheRead") },
      cacheRate:
        cacheTotal > 0 ? Math.round((current.cacheRead / cacheTotal) * 100) : 0,
    };
  });

  const costSummary = $derived({
    thisWeek: buckets.week.get(thisWeekKey)?.cost ?? 0,
    thisMonth: buckets.month.get(thisMonthKey)?.cost ?? 0,
  });

  const DAILY_DEFAULT = 5;
  let showAllDays = $state(false);
  let showCachedTokens = $state(false);
  const visibleDailyCost = $derived(
    showAllDays ? dailyCost : dailyCost.slice(-DAILY_DEFAULT),
  );

  function fmtCost(n: number) {
    return `$${n.toFixed(4)}`;
  }
  function fmtCostShort(n: number) {
    return `$${n.toFixed(2)}`;
  }
  function fmtTokensShort(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return Math.round(n).toString();
  }
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
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }
  function fmtTokens(n: number) {
    return n.toLocaleString();
  }

  const agentCosts = $derived(
    (data.agentCosts as Record<
      string,
      { cost: number; estimated: boolean }
    >) ?? {},
  );

  // Agents arrive as AgentEntry[] from /api/agents. Adapt to the shape the
  // table needs (parentName + ticketId, no children/epicId).
  type AgentRow = {
    name: string;
    type: string;
    status: string;
    parent?: string;
    ticketId?: string;
    createdAt: string;
  };

  const allAgents = $derived<AgentRow[]>(
    (data.agents ?? [])
      .map((a) => ({
        name: a.name,
        type: a.type,
        status: a.status,
        parent: "parentName" in a ? a.parentName : undefined,
        ticketId: "ticketId" in a ? a.ticketId : undefined,
        createdAt: a.createdAt,
      }))
      .sort((a, b) => {
        const order: Record<string, number> = {
          orchestrator: 0,
          builder: 1,
          helper: 2,
          scheduled: 3,
          bare: 4,
        };
        return (order[a.type] ?? 5) - (order[b.type] ?? 5);
      }),
  );

  const ONE_HOUR = 60 * 60 * 1000;
  const liveAgents = $derived(allAgents.filter((a) => a.status !== "killed"));
  const killedAgents = $derived(allAgents.filter((a) => a.status === "killed"));
  const recentlyKilled = $derived(
    killedAgents.filter((a) => now - new Date(a.createdAt).getTime() < ONE_HOUR),
  );
  const olderKilled = $derived(
    killedAgents.filter(
      (a) => now - new Date(a.createdAt).getTime() >= ONE_HOUR,
    ),
  );
  const agentList = $derived([...liveAgents, ...recentlyKilled]);
  const activeAgentCount = $derived(liveAgents.length);
  let showAllKilled = $state(false);
  const displayAgents = $derived(
    showAllKilled ? [...agentList, ...olderKilled] : agentList,
  );

  function agentTypeIcon(type: string) {
    switch (type) {
      case "orchestrator":
        return "\u{1F451}";
      case "builder":
        return "\u{1F528}";
      case "helper":
        return "\u{26A1}";
      case "scheduled":
        return "\u{1F4C5}";
      default:
        return "\u{1F4AD}";
    }
  }

  function statusBadgeClass(status: string): string {
    if (status === "idle" || status === "working") return "ok";
    if (status === "stalled") return "warn";
    if (status === "error" || status === "killed") return "err";
    return "";
  }

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
        <span class="stat-detail"
          >{todayStats.turns} turns &middot; avg {fmtCost(todayStats.avgCost)}</span
        >
      </div>
    </div>
    <div class="card stat-card">
      <div class="stat">
        <span class="stat-label">This Week</span>
        <span class="stat-value">{fmtCost(weekStats.cost)}</span>
        <span class="stat-detail"
          >{weekStats.turns} turns &middot; avg {fmtCost(weekStats.avgCost)}</span
        >
      </div>
    </div>
    <div class="card stat-card">
      <div class="stat">
        <span class="stat-label">Cache Hit Rate</span>
        <span class="stat-value">{allStats.cacheRate}%</span>
        <span class="stat-detail"
          >{fmtTokens(allStats.cacheRead)} / {fmtTokens(
            allStats.cacheRead + allStats.cacheCreation,
          )} tokens</span
        >
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
      <span class="stat-detail">Turns in the last year</span>
    </div>
    <ActivityGrid activityByDate={data.activityByDate} />
  </div>

  <!-- Main Grid -->
  <div class="main-grid">
    <!-- Daily Cost Chart -->
    <div class="card chart-card">
      <div class="card-header">
        <h2>Daily Cost</h2>
        <div class="card-header-right">
          <Toggle
            bind:checked={showCachedTokens}
            label="cached"
            title="{showCachedTokens ? 'Hide' : 'Show'} cached token segment"
          />
          <span class="stat-detail">
            Week {fmtCostShort(costSummary.thisWeek)} &middot; Month {fmtCostShort(
              costSummary.thisMonth,
            )}
            {#if dailyCost.length > DAILY_DEFAULT}
              <button
                class="toggle-link"
                onclick={() => (showAllDays = !showAllDays)}
              >
                {showAllDays
                  ? `Show last ${DAILY_DEFAULT}`
                  : `Show all ${dailyCost.length}`}
              </button>
            {/if}
          </span>
        </div>
      </div>
      <div class="chart-legend">
        {#each models as model}
          <span class="legend-item">
            <span
              class="legend-swatch"
              style="background: {modelColors[model]}"
            ></span>
            {model}
          </span>
        {/each}
        {#if models.length > 0}
          <span class="legend-sep"></span>
        {/if}
        <span class="legend-item">
          <span
            class="legend-swatch"
            style="background: var(--chart-input, #818cf8)"
          ></span>
          input
        </span>
        {#if showCachedTokens}
          <span class="legend-item">
            <span
              class="legend-swatch"
              style="background: var(--chart-input-cached, #a5b4fc)"
            ></span>
            cached
          </span>
        {/if}
        <span class="legend-item">
          <span
            class="legend-swatch"
            style="background: var(--chart-output, #f59e0b)"
          ></span>
          output
        </span>
      </div>
      <Tooltip.Provider delayDuration={150}>
        <div class="bar-chart">
          {#each visibleDailyCost as day}
            <div class="day-group">
              <span class="bar-label">{day.day.slice(5)}</span>
              <div class="bar-track">
                {#each models as model}
                  {@const seg = day.costByModel[model] ?? 0}
                  {#if seg > 0}
                    <Tooltip.Root>
                      <Tooltip.Trigger
                        class="bar-fill-segment"
                        style="width: {(seg / maxDailyCost) *
                          100}%; background: {modelColors[model]}"
                      />
                      <Tooltip.Portal>
                        <Tooltip.Content
                          class="segment-tooltip"
                          sideOffset={6}
                        >
                          <span class="segment-tooltip-label">{model}</span>
                          <span class="segment-tooltip-value"
                            >{fmtCost(seg)}</span
                          >
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  {/if}
                {/each}
              </div>
              <span class="bar-value">{fmtCost(day.totalCost)}</span>
              <div class="bar-track token-track">
                {#if day.inputUncached > 0}
                  <Tooltip.Root>
                    <Tooltip.Trigger
                      class="bar-fill-segment"
                      style="width: {(day.inputUncached /
                        (showCachedTokens
                          ? maxDailyTokens
                          : maxDailyTokensNoCached)) *
                        100}%; background: var(--chart-input, #818cf8)"
                    />
                    <Tooltip.Portal>
                      <Tooltip.Content class="segment-tooltip" sideOffset={6}>
                        <span class="segment-tooltip-label">Input</span>
                        <span class="segment-tooltip-value"
                          >{fmtTokens(day.inputUncached)}</span
                        >
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                {/if}
                {#if showCachedTokens && day.inputCached > 0}
                  <Tooltip.Root>
                    <Tooltip.Trigger
                      class="bar-fill-segment"
                      style="width: {(day.inputCached / maxDailyTokens) *
                        100}%; background: var(--chart-input-cached, #a5b4fc)"
                    />
                    <Tooltip.Portal>
                      <Tooltip.Content class="segment-tooltip" sideOffset={6}>
                        <span class="segment-tooltip-label">Cached</span>
                        <span class="segment-tooltip-value"
                          >{fmtTokens(day.inputCached)}</span
                        >
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                {/if}
                {#if day.output > 0}
                  <Tooltip.Root>
                    <Tooltip.Trigger
                      class="bar-fill-segment"
                      style="width: {(day.output /
                        (showCachedTokens
                          ? maxDailyTokens
                          : maxDailyTokensNoCached)) *
                        100}%; background: var(--chart-output, #f59e0b)"
                    />
                    <Tooltip.Portal>
                      <Tooltip.Content class="segment-tooltip" sideOffset={6}>
                        <span class="segment-tooltip-label">Output</span>
                        <span class="segment-tooltip-value"
                          >{fmtTokens(day.output)}</span
                        >
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                {/if}
              </div>
              <span class="bar-value"
                >{fmtTokens(
                  showCachedTokens
                    ? day.totalTokens
                    : day.inputUncached + day.output,
                )}</span
              >
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
        <div class="period-tabs">
          {#each PERIODS as p}
            <button
              class="period-tab"
              class:active={tokenPeriod === p}
              onclick={() => (tokenPeriod = p)}>{periodLabels[p]}</button
            >
          {/each}
        </div>
      </div>
      <div class="token-grid">
        <div class="token-item">
          <span class="token-label">Input</span>
          <div class="token-value-row">
            <span class="token-value">{fmtTokens(tokenView.input.value)}</span>
            <div class="token-aggs">
              <span>avg {fmtTokensShort(tokenView.input.mean)}</span>
              <span>med {fmtTokensShort(tokenView.input.median)}</span>
            </div>
          </div>
        </div>
        <div class="token-item">
          <span class="token-label">Output</span>
          <div class="token-value-row">
            <span class="token-value">{fmtTokens(tokenView.output.value)}</span>
            <div class="token-aggs">
              <span>avg {fmtTokensShort(tokenView.output.mean)}</span>
              <span>med {fmtTokensShort(tokenView.output.median)}</span>
            </div>
          </div>
        </div>
        <div class="token-item">
          <span class="token-label">Cache Creation</span>
          <div class="token-value-row">
            <span class="token-value"
              >{fmtTokens(tokenView.cacheCreation.value)}</span
            >
            <div class="token-aggs">
              <span>avg {fmtTokensShort(tokenView.cacheCreation.mean)}</span>
              <span>med {fmtTokensShort(tokenView.cacheCreation.median)}</span>
            </div>
          </div>
        </div>
        <div class="token-item accent">
          <span class="token-label">Cache Read</span>
          <div class="token-value-row">
            <span class="token-value"
              >{fmtTokens(tokenView.cacheRead.value)}</span
            >
            <div class="token-aggs">
              <span>avg {fmtTokensShort(tokenView.cacheRead.mean)}</span>
              <span>med {fmtTokensShort(tokenView.cacheRead.median)}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="cache-bar">
        <div class="cache-bar-label">Cache efficiency</div>
        <div class="cache-bar-track">
          <div
            class="cache-bar-read"
            style="width: {tokenView.cacheRate}%"
          ></div>
        </div>
        <div class="cache-bar-pct">{tokenView.cacheRate}%</div>
      </div>
    </div>

    <!-- Agents -->
    <div class="card agents-card">
      <div class="card-header">
        <h2>Agents</h2>
        <span class="stat-detail">
          {activeAgentCount} active{#if olderKilled.length > 0}
            <button
              class="toggle-link"
              onclick={() => (showAllKilled = !showAllKilled)}
            >
              {showAllKilled ? "Hide" : "Show"}
              {olderKilled.length} killed
            </button>
          {/if}
        </span>
      </div>
      {#if displayAgents.length === 0}
        <p class="empty-state">
          No agents registered. Send a message in <a href="/">Chat</a> to spawn the
          orchestrator.
        </p>
      {:else}
        <div class="table-scroll-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Type</th>
                <th>Status</th>
                <th>Cost</th>
                <th>Parent</th>
                <th>Ticket</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {#each displayAgents as agent}
                <tr class:destroyed={agent.status === "killed"}>
                  <td class="agent-name">{agent.name}</td>
                  <td>
                    <span class="agent-type-badge" data-type={agent.type}>
                      {agentTypeIcon(agent.type)}
                      {agent.type}
                    </span>
                  </td>
                  <td>
                    <span class="badge {statusBadgeClass(agent.status)}">
                      {agent.status}
                    </span>
                  </td>
                  <td class="text-mono">
                    {#if agentCosts[agent.name]}
                      {fmtCost(agentCosts[agent.name].cost)}
                    {:else}
                      &mdash;
                    {/if}
                  </td>
                  <td class="text-muted">{agent.parent ?? "—"}</td>
                  <td class="text-mono">{agent.ticketId ?? "—"}</td>
                  <td>{fmtAge(agent.createdAt)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>

    <!-- Files -->
    <div class="card config-card">
      <div class="card-header">
        <h2>Files</h2>
        <div class="file-tabs">
          {#each stateFiles as file, i}
            <button
              class="file-tab"
              class:active={activeFileTab === i}
              class:missing={file.content == null}
              onclick={() => (activeFileTab = i)}
            >
              {file.label}
            </button>
          {/each}
        </div>
      </div>
      <div class="config-path">{activeFile?.path ?? ""}</div>
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

  .stats-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
  }

  .stat-card {
    padding: 1rem 1.25rem;
  }

  .activity-card {
    padding: 1rem 1.25rem;
  }

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

  .table-scroll-wrapper {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
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

  .toggle-link {
    background: none;
    border: none;
    color: var(--accent-primary);
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
    background: var(--status-error-bg);
    color: var(--status-error);
  }

  .bar-chart {
    display: grid;
    grid-template-columns: auto 1fr auto;
    column-gap: 0.75rem;
    row-gap: 0.6rem;
    align-items: center;
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
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
    grid-template-rows: auto auto;
    column-gap: 0.75rem;
    row-gap: 0.075rem;
    align-items: center;
  }

  .day-group .bar-label {
    grid-row: 1 / 3;
    grid-column: 1;
    align-self: start;
    padding-top: 0.15rem;
  }

  .day-group .bar-track {
    grid-column: 2;
    display: flex;
    width: 100%;
    min-width: 0;
    height: 1.1rem;
    background: var(--bg-tertiary);
    border-radius: 3px;
    overflow: hidden;
  }

  .day-group .token-track {
    height: 0.6rem;
  }

  .day-group .bar-value {
    grid-column: 3;
    width: auto;
    white-space: nowrap;
  }

  .legend-sep {
    width: 1px;
    height: 0.8rem;
    background: var(--border-primary);
    margin: 0 0.25rem;
  }

  .chart-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
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

  .card-header-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

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

  .token-value-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .token-aggs {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.05rem;
    font-family: var(--font-mono);
    font-size: 0.6rem;
    line-height: 1.1;
    color: var(--text-tertiary);
    white-space: nowrap;
  }

  .period-tabs {
    display: flex;
    gap: 0.25rem;
  }

  .period-tab {
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
  .period-tab:hover {
    color: var(--text-secondary);
    background: var(--bg-tertiary);
  }
  .period-tab.active {
    color: var(--accent-primary);
    background: var(--accent-glow);
    border-color: var(--accent-primary);
  }

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
    flex-wrap: wrap;
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

  .empty-state {
    text-align: center;
    padding: 2rem;
    color: var(--text-tertiary);
    font-size: 0.85rem;
  }

  @media (max-width: 768px) {
    .stats-row {
      grid-template-columns: repeat(2, 1fr);
    }
    .main-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 480px) {
    .stats-row {
      grid-template-columns: 1fr;
    }
    .token-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
