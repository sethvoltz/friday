<script lang="ts">
  import { Tooltip } from "bits-ui";
  import { invalidateAll } from "$app/navigation";
  import { dashboardData } from "$lib/stores/dashboard-data.svelte";
  import ActivityGrid from "$lib/components/Dashboard/ActivityGrid.svelte";
  import Toggle from "$lib/components/Toggle/Toggle.svelte";
  import { fmtTokensCompact } from "$lib/util/format";
  import { agentIconFor } from "$lib/util/agent-icon";
  import { zeroSync } from "$lib/stores/zero.svelte";
  import { isExpectedToday, bucketKey } from "$lib/habits/adapt";
  import HabitCheckButton from "$lib/components/Habits/HabitCheckButton.svelte";
  import QuickAdd from "$lib/components/Inbox/QuickAdd.svelte";
  import type { ZeroHabitRow, ZeroHabitCheckinRow } from "$lib/habits/adapt";
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

  const now = Date.now();

  const todayStats = $derived(data.stats.today);
  const weekStats = $derived(data.stats.week);
  const allStats = $derived(data.stats.all);

  const dailyCost = $derived(data.dailyCost);
  const models = $derived(data.models);
  // FRI-124: categorical chart series — six per-palette hue-distinct
  // slots, used to color the stacked cost bars by model. Previously this
  // mixed --chart-1, --chart-cache (semantic, not categorical), and
  // four hardcoded hexes; now consumes --chart-1..6 from palettes.css
  // cleanly. --chart-cache stays in the catalog for `.cache-bar-read`
  // (line 1071 of this file) — kept per reviewer correction.
  const modelColors = $derived.by(() => {
    const palette = [
      "var(--chart-1)",
      "var(--chart-2)",
      "var(--chart-3)",
      "var(--chart-4)",
      "var(--chart-5)",
      "var(--chart-6)",
    ];
    const out: Record<string, string> = {};
    models.forEach((m, i) => {
      out[m] = palette[i % palette.length];
    });
    return out;
  });

  type Period = "day" | "week" | "month";
  const PERIODS: Period[] = ["day", "week", "month"];
  let tokenPeriod = $state<Period>("day");
  const periodLabels: Record<Period, string> = {
    day: "Today",
    week: "Past 7 Days",
    month: "Past 30 Days",
  };

  const tokenView = $derived.by(() => {
    const v = data.tokenViews[tokenPeriod];
    return {
      input: { value: v.current.input, ...v.aggs.input },
      output: { value: v.current.output, ...v.aggs.output },
      cacheCreation: {
        value: v.current.cacheCreation,
        ...v.aggs.cacheCreation,
      },
      cacheRead: { value: v.current.cacheRead, ...v.aggs.cacheRead },
      cacheRate: v.cacheRate,
    };
  });

  const costSummary = $derived(data.costSummary);

  const DAILY_DEFAULT = 5;
  let showAllDays = $state(false);
  let showCachedTokens = $state(false);
  const visibleDailyCost = $derived(
    showAllDays ? dailyCost : dailyCost.slice(-DAILY_DEFAULT),
  );
  const maxDailyCost = $derived(
    Math.max(...visibleDailyCost.map((d) => d.totalCost), 0.01),
  );
  const maxDailyTokens = $derived(
    Math.max(...visibleDailyCost.map((d) => d.totalTokens), 1),
  );
  const maxDailyTokensNoCached = $derived(
    Math.max(...visibleDailyCost.map((d) => d.inputUncached + d.output), 1),
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
  const liveAgents = $derived(allAgents.filter((a) => a.status !== "archived"));
  const archivedAgents = $derived(
    allAgents.filter((a) => a.status === "archived"),
  );
  const recentlyArchived = $derived(
    archivedAgents.filter(
      (a) => now - new Date(a.createdAt).getTime() < ONE_HOUR,
    ),
  );
  const olderArchived = $derived(
    archivedAgents.filter(
      (a) => now - new Date(a.createdAt).getTime() >= ONE_HOUR,
    ),
  );
  const agentList = $derived([...liveAgents, ...recentlyArchived]);
  const activeAgentCount = $derived(liveAgents.length);
  let showAllArchived = $state(false);
  const displayAgents = $derived(
    showAllArchived ? [...agentList, ...olderArchived] : agentList,
  );

  function statusBadgeClass(status: string): string {
    if (status === "idle" || status === "working") return "ok";
    if (status === "stalled") return "warn";
    if (status === "error" || status === "archived") return "err";
    return "";
  }

  const stateFiles = $derived(data.stateFiles ?? []);
  let activeFileTab = $state(0);
  const activeFile = $derived(stateFiles[activeFileTab]);

  // FRI-169 — Today card. Live habit rows + Check-ins from Zero
  // (zeroSync.habits / zeroSync.habitCheckins are unconditional reactive
  // bindings), grouped by Time-of-day bucket. We show only habits that are
  // EXPECTED today (active + scheduled by cadence/days_of_week/window) via
  // the adapter's isExpectedToday — never compute streaks by hand here.
  const nowDate = new Date(now);

  // The four buckets in their fixed display order; null bucket -> "anytime".
  type Bucket = "morning" | "afternoon" | "evening" | "anytime";
  const BUCKET_ORDER: Bucket[] = ["morning", "afternoon", "evening", "anytime"];
  const BUCKET_LABELS: Record<Bucket, string> = {
    morning: "Morning",
    afternoon: "Afternoon",
    evening: "Evening",
    anytime: "Anytime",
  };

  // Check-ins indexed by habit so each control sees only its own log.
  const checkinsByHabit = $derived.by(() => {
    const out = new Map<string, ZeroHabitCheckinRow[]>();
    for (const c of zeroSync.habitCheckins as ZeroHabitCheckinRow[]) {
      const list = out.get(c.habit_id);
      if (list) list.push(c);
      else out.set(c.habit_id, [c]);
    }
    return out;
  });

  // Today's expected habits grouped by bucket, in display order. Empty
  // buckets are dropped so the card renders only the groups with work due.
  const todayGroups = $derived.by(() => {
    const expected = (zeroSync.habits as ZeroHabitRow[]).filter((h) =>
      isExpectedToday(h, nowDate),
    );
    const byBucket = new Map<Bucket, ZeroHabitRow[]>();
    for (const h of expected) {
      const b = bucketKey(h) as Bucket;
      const list = byBucket.get(b);
      if (list) list.push(h);
      else byBucket.set(b, [h]);
    }
    return BUCKET_ORDER.filter((b) => byBucket.has(b)).map((b) => ({
      bucket: b,
      label: BUCKET_LABELS[b],
      habits: byBucket.get(b)!,
    }));
  });

  const todayHabitCount = $derived(
    todayGroups.reduce((n, g) => n + g.habits.length, 0),
  );

  // Per-habit busy flags so an in-flight optimistic write disables just its
  // own control (keyed by habit id).
  let habitBusy = $state<Record<string, boolean>>({});

  function habitCheckins(habitId: string): ZeroHabitCheckinRow[] {
    return checkinsByHabit.get(habitId) ?? [];
  }

  // Check the habit off: INSERT one Check-in via the Zero mutator (the
  // wrapper supplies a fresh uuid + ts=Date.now()). Optimistic — the live
  // binding reflects it without a refetch.
  async function checkOff(habit: ZeroHabitRow) {
    if (habitBusy[habit.id]) return;
    habitBusy = { ...habitBusy, [habit.id]: true };
    try {
      const result = zeroSync.habitCheckin({ habit_id: habit.id });
      await result?.server;
    } finally {
      habitBusy = { ...habitBusy, [habit.id]: false };
    }
  }

  // Undo today's check-off: delete the most recent Check-in for this habit
  // (the one the user just added) via the single-row undo mutator.
  async function undoCheckOff(habit: ZeroHabitRow) {
    if (habitBusy[habit.id]) return;
    const mine = habitCheckins(habit.id);
    if (mine.length === 0) return;
    const latest = mine.reduce((a, b) => (b.ts > a.ts ? b : a));
    habitBusy = { ...habitBusy, [habit.id]: true };
    try {
      const result = zeroSync.habitCheckinUndo({ id: latest.id });
      await result?.server;
    } finally {
      habitBusy = { ...habitBusy, [habit.id]: false };
    }
  }
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
        <span class="stat-label">Past 7 Days</span>
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

  <!-- Quick capture (FRI-171) — compact stateless-intake box near the Today
       card (owner default placement). NOT the full chat. -->
  <QuickAdd />

  <!-- Today (habits due) — FRI-169. Must precede .activity-card (AC15). -->
  <div class="card today-card" data-testid="today-card">
    <div class="card-header">
      <h2>Today</h2>
      <span class="stat-detail">
        {todayHabitCount === 0
          ? "Nothing due"
          : `${todayHabitCount} due`}
      </span>
    </div>
    {#if todayHabitCount === 0}
      <p class="empty-state">No habits due today.</p>
    {:else}
      <div class="today-groups">
        {#each todayGroups as group (group.bucket)}
          <div class="today-group">
            <span class="today-bucket-label">{group.label}</span>
            <div class="today-habits">
              {#each group.habits as habit (habit.id)}
                <HabitCheckButton
                  row={habit}
                  checkins={habitCheckins(habit.id)}
                  now={nowDate}
                  busy={habitBusy[habit.id] ?? false}
                  oncheck={checkOff}
                  onundo={undoCheckOff}
                />
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}
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
            7d {fmtCostShort(costSummary.thisWeek)} &middot; 30d {fmtCostShort(
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
            style="background: var(--chart-input)"
          ></span>
          input
        </span>
        {#if showCachedTokens}
          <span class="legend-item">
            <span
              class="legend-swatch"
              style="background: var(--chart-input-cached)"
            ></span>
            cached
          </span>
        {/if}
        <span class="legend-item">
          <span
            class="legend-swatch"
            style="background: var(--chart-output)"
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
                        100}%; background: var(--chart-input)"
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
                        100}%; background: var(--chart-input-cached)"
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
                        100}%; background: var(--chart-output)"
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
            <span class="token-value">{fmtTokensCompact(tokenView.input.value)}</span>
            <div class="token-aggs">
              <span>avg {fmtTokensShort(tokenView.input.mean)}</span>
              <span>med {fmtTokensShort(tokenView.input.median)}</span>
            </div>
          </div>
        </div>
        <div class="token-item">
          <span class="token-label">Output</span>
          <div class="token-value-row">
            <span class="token-value">{fmtTokensCompact(tokenView.output.value)}</span>
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
              >{fmtTokensCompact(tokenView.cacheCreation.value)}</span
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
              >{fmtTokensCompact(tokenView.cacheRead.value)}</span
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
          {activeAgentCount} active{#if olderArchived.length > 0}
            <button
              class="toggle-link"
              onclick={() => (showAllArchived = !showAllArchived)}
            >
              {showAllArchived ? "Hide" : "Show"}
              {olderArchived.length} archived
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
                {@const Icon = agentIconFor(agent.type)}
                <tr class:archived={agent.status === "archived"}>
                  <td class="agent-name">{agent.name}</td>
                  <td>
                    <span class="agent-type-badge" data-type={agent.type}>
                      <span
                        class="agent-icon agent-{agent.type}"
                        aria-hidden="true"
                      >
                        <Icon size={16} strokeWidth={2} />
                      </span>
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

  .today-card {
    padding: 1rem 1.25rem;
  }

  .today-groups {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .today-group {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .today-bucket-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
  }

  .today-habits {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    gap: 0.5rem;
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

  .agent-name {
    font-family: var(--font-mono);
    font-weight: 600;
  }

  .agent-type-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    white-space: nowrap;
  }
  .agent-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
  .agent-icon.agent-orchestrator { color: var(--agent-orchestrator); }
  .agent-icon.agent-helper { color: var(--agent-helper); }
  .agent-icon.agent-builder { color: var(--agent-builder); }
  .agent-icon.agent-scheduled { color: var(--agent-scheduled); }
  .agent-icon.agent-bare { color: var(--agent-bare); }

  .text-muted {
    color: var(--text-tertiary);
    font-size: 0.85rem;
  }

  .text-mono {
    font-family: var(--font-mono);
    font-size: 0.8rem;
  }

  tr.archived {
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
    box-shadow: var(--shadow-md);
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
