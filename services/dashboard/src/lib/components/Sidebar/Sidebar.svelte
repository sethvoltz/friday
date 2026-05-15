<script lang="ts">
  import {
    chat,
    type AgentInfo,
    type SidebarSessionSummary,
  } from "$lib/stores/chat.svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import Toggle from "$lib/components/Toggle/Toggle.svelte";
  import { loadJSON, saveJSON } from "$lib/stores/persistent";
  import { onMount } from "svelte";
  import {
    DraftingCompass,
    LifeBuoy,
    Hammer,
    CalendarClock,
    PawPrint,
  } from "lucide-svelte";

  // Lucide glyph + color-var per agent type. Bare maps to PawPrint because
  // Lucide has no literal bear; PawPrint is the closest animal glyph and
  // reads as the "experimental / wild" agent kind. Tooltip retains the
  // raw type string so screen-reader users still get the typed label.
  const AGENT_ICON: Record<string, typeof DraftingCompass> = {
    orchestrator: DraftingCompass,
    helper: LifeBuoy,
    builder: Hammer,
    scheduled: CalendarClock,
    bare: PawPrint,
  };
  function iconFor(type: string): typeof DraftingCompass {
    return AGENT_ICON[type] ?? PawPrint;
  }

  // The route is the authoritative source for which sidebar row is
  // active and how deep the menu should be expanded. `/` → orchestrator
  // pinned row. `/sessions/<agent>` → that agent's primary row.
  // `/sessions/<agent>/<session>` → that agent's row + a highlighted
  // history-row matching the session id.
  //
  // We deliberately derive the active highlight from the route, NOT
  // from `chat.focusedAgent`, because past-session (readonly) views
  // don't update focusedAgent — that signal means "the agent the user
  // is live-chatting with." Past sessions are inspection, not chat;
  // the sidebar should pin them visually without polluting the live
  // signal that drives SSE filtering and the inflight-turn indicator.
  let routeAgent = $derived($page.params.agent ?? "");
  let routeSession = $derived($page.params.session ?? "");
  // "friday" is the orchestrator's pinned name and the default for `/`.
  let activeAgent = $derived(routeAgent || "friday");

  async function loadAgents() {
    try {
      const r = await fetch("/api/agents");
      if (!r.ok) return;
      chat.agents = (await r.json()) as AgentInfo[];
    } catch {
      // ignore
    }
  }

  // F2-A: SSE drives the sidebar (lifecycle / status / message events
  // update chat.agents inline), but a periodic /api/agents poll
  // self-heals any missed event (cross-tab divergence, reconnect gap,
  // tab hidden during a flurry). 30s default; overridable via
  // FRIDAY_AGENTS_POLL_MS for power users with a custom build.
  const POLL_MS = (() => {
    const env = (
      import.meta as unknown as { env?: Record<string, string | undefined> }
    ).env;
    const raw = env?.PUBLIC_FRIDAY_AGENTS_POLL_MS;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 30_000;
  })();
  onMount(() => {
    void loadAgents();
    const id = setInterval(() => void loadAgents(), POLL_MS);
    return () => clearInterval(id);
  });

  function hrefFor(name: string, type: string): string {
    return type === "orchestrator" ? "/" : `/sessions/${name}`;
  }

  function focusAgent(name: string, type: string) {
    open = false;
    chat.clearUnread(name);
    void goto(hrefFor(name, type));
  }

  // Filters — persisted across reloads so the user's preference survives.
  // Initialize to defaults at SSR; rehydrate from localStorage inside
  // onMount so the server-rendered HTML matches the first client render
  // (no hydration mismatch warnings, no flash of unfiltered content if
  // the persisted value differs from the default).
  let showArchived = $state(false);
  let showInactive = $state(false);
  let filtersHydrated = $state(false);
  onMount(() => {
    // Migrate legacy `sidebar:showKilled` key (PR 0 rename).
    const legacyKilled = loadJSON<boolean | null>("sidebar:showKilled", null);
    showArchived = loadJSON<boolean>(
      "sidebar:showArchived",
      legacyKilled ?? false,
    );
    showInactive = loadJSON<boolean>("sidebar:showInactive", false);
    filtersHydrated = true;
  });
  $effect(() => {
    if (!filtersHydrated) return;
    saveJSON("sidebar:showArchived", showArchived);
  });
  $effect(() => {
    if (!filtersHydrated) return;
    saveJSON("sidebar:showInactive", showInactive);
  });

  function isActive(status: string): boolean {
    return status === "idle" || status === "working";
  }

  let pinned = $derived<AgentInfo>(
    chat.agents.find((a) => a.type === "orchestrator") ?? {
      name: "friday",
      type: "orchestrator",
      status: "idle",
    },
  );
  let others = $derived(
    chat.agents
      .filter((a) => a.type !== "orchestrator")
      .filter((a) => {
        // F2-D: always show the route-active row, regardless of the
        // filter state — the user is reading that agent's chat in the
        // main pane, so losing the sidebar row when the agent gets
        // archived mid-view is a UX cliff. Uses activeAgent (route
        // derived) instead of focusedAgent so past-session views of
        // archived agents stay pinned too.
        if (a.name === activeAgent) return true;
        if (a.status === "archived") return showArchived;
        if (!isActive(a.status)) return showInactive;
        return true;
      })
      // Recency-first within each age bucket below. Falls back to name when
      // neither agent has a timestamp yet (SSE-synthesized rows that haven't
      // been touched by an /api/agents poll).
      .sort((a, b) => ageMsOf(b) - ageMsOf(a) || a.name.localeCompare(b.name)),
  );

  // Age-bucketed separators. Buckets are derived from local-time calendar
  // boundaries against `now`, computed once per render — re-derived through
  // Svelte 5 reactivity whenever `chat.agents` (and therefore `others`)
  // changes, which is the same cadence the agent rows themselves refresh
  // at. We don't try to live-rebucket while the tab sits open: an agent
  // crossing midnight from "Today" into "Yesterday" without a state change
  // is not worth a setInterval — the next SSE event or 30s poll re-runs
  // this derivation.
  type BucketKey =
    | "today"
    | "yesterday"
    | "earlierWeek"
    | "lastWeek"
    | "earlierMonth"
    | "lastMonth"
    | "earlierYear"
    | "older";
  const BUCKET_ORDER: BucketKey[] = [
    "today",
    "yesterday",
    "earlierWeek",
    "lastWeek",
    "earlierMonth",
    "lastMonth",
    "earlierYear",
    "older",
  ];
  const BUCKET_LABEL: Record<BucketKey, string> = {
    today: "Today",
    yesterday: "Yesterday",
    earlierWeek: "Earlier this Week",
    lastWeek: "Last Week",
    earlierMonth: "Earlier this Month",
    lastMonth: "Last Month",
    earlierYear: "Earlier this Year",
    older: "Older",
  };

  function ageMsOf(a: AgentInfo): number {
    // updatedAt wins; createdAt is the fallback. Missing both → 0, which
    // parks the row in "Older". That's the right cliff: an entry the
    // daemon hasn't acknowledged yet shouldn't claim "Today".
    const src = a.updatedAt ?? a.createdAt;
    if (!src) return 0;
    const t = Date.parse(src);
    return Number.isFinite(t) ? t : 0;
  }

  function bucketBoundaries(now: Date) {
    // Start-of-day helpers in *local* time — same calendar the user
    // perceives. Sunday-start weeks; the labels read fine either way and
    // we don't want to import a locale lib for this.
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
    const startOfThisWeek =
      startOfToday - now.getDay() * 24 * 60 * 60 * 1000;
    const startOfLastWeek = startOfThisWeek - 7 * 24 * 60 * 60 * 1000;
    const startOfThisMonth = new Date(
      now.getFullYear(),
      now.getMonth(),
      1,
    ).getTime();
    const startOfLastMonth = new Date(
      now.getFullYear(),
      now.getMonth() - 1,
      1,
    ).getTime();
    const startOfThisYear = new Date(now.getFullYear(), 0, 1).getTime();
    return {
      startOfToday,
      startOfYesterday,
      startOfThisWeek,
      startOfLastWeek,
      startOfThisMonth,
      startOfLastMonth,
      startOfThisYear,
    };
  }

  function bucketOf(ts: number, b: ReturnType<typeof bucketBoundaries>): BucketKey {
    if (ts >= b.startOfToday) return "today";
    if (ts >= b.startOfYesterday) return "yesterday";
    if (ts >= b.startOfThisWeek) return "earlierWeek";
    if (ts >= b.startOfLastWeek) return "lastWeek";
    if (ts >= b.startOfThisMonth) return "earlierMonth";
    if (ts >= b.startOfLastMonth) return "lastMonth";
    if (ts >= b.startOfThisYear) return "earlierYear";
    return "older";
  }

  let bucketedOthers = $derived.by(() => {
    const b = bucketBoundaries(new Date());
    const groups: Array<{ key: BucketKey; label: string; items: AgentInfo[] }> = [];
    const index: Partial<Record<BucketKey, number>> = {};
    for (const a of others) {
      const key = bucketOf(ageMsOf(a), b);
      let idx = index[key];
      if (idx === undefined) {
        idx = groups.length;
        index[key] = idx;
        groups.push({ key, label: BUCKET_LABEL[key], items: [] });
      }
      groups[idx]!.items.push(a);
    }
    // Stable canonical ordering — buckets render in BUCKET_ORDER regardless
    // of which arrived first in the input list.
    groups.sort(
      (a, b) =>
        BUCKET_ORDER.indexOf(a.key) - BUCKET_ORDER.indexOf(b.key),
    );
    return groups;
  });
  // Counts of agents hidden by each filter switch. Excludes the
  // orchestrator and the route-active row (both always show). When the
  // toggle is on, nothing is being hidden by that toggle → count is 0
  // and the label hides the parenthetical.
  let archivedHidden = $derived(
    showArchived
      ? 0
      : chat.agents.filter(
          (a) =>
            a.type !== "orchestrator" &&
            a.name !== activeAgent &&
            a.status === "archived",
        ).length,
  );
  let inactiveHidden = $derived(
    showInactive
      ? 0
      : chat.agents.filter(
          (a) =>
            a.type !== "orchestrator" &&
            a.name !== activeAgent &&
            a.status !== "archived" &&
            !isActive(a.status),
        ).length,
  );
  let focused = $derived<AgentInfo>(
    chat.agents.find((a) => a.name === chat.focusedAgent) ?? pinned,
  );

  function statusDot(status: string): string {
    return status === "working"
      ? "var(--status-ok)"
      : status === "stalled"
        ? "var(--status-warn)"
        : status === "error"
          ? "var(--status-error)"
          : status === "archived"
            ? "var(--text-tertiary)"
            : "var(--text-tertiary)";
  }

  // Expand state + session cache live on the chat store so they survive
  // ChatShell re-mounts. The Sidebar is mounted inside ChatShell, which
  // is mounted per-route by each page's +page.svelte — so every nav
  // between /, /sessions/<a>, /sessions/<a>/<s> wiped this state until
  // we moved it.
  function isExpanded(name: string): boolean {
    // Route-forced expansion: when the URL points at a past session of
    // this agent, force its history submenu open so the user can see
    // (and the active-row highlight can land on) the session they're
    // viewing. User can still toggle other rows freely; clicking the
    // collapse button on the route's agent is the only place that
    // contention surfaces, and route wins.
    if (routeAgent === name && routeSession) return true;
    return chat.sidebarExpanded[name] ?? false;
  }

  async function toggleHistory(name: string) {
    // If the route forces this row open we no-op the user click —
    // collapsing-then-immediately-re-expanding via route effect would
    // be jarring. User can always navigate away to truly collapse.
    if (routeAgent === name && routeSession) return;
    chat.sidebarExpanded[name] = !chat.sidebarExpanded[name];
    if (
      chat.sidebarExpanded[name] &&
      !chat.sidebarPastSessions[name] &&
      !chat.sidebarLoadingSessions[name]
    ) {
      await loadPastSessions(name);
    }
  }

  async function loadPastSessions(name: string): Promise<void> {
    chat.sidebarLoadingSessions[name] = true;
    try {
      const r = await fetch(`/api/agents/${name}/sessions`);
      if (r.ok) {
        chat.sidebarPastSessions[name] =
          (await r.json()) as SidebarSessionSummary[];
      }
    } finally {
      chat.sidebarLoadingSessions[name] = false;
    }
  }

  // When the route points at a past session, kick off a sessions fetch
  // if we don't already have one cached — otherwise the auto-expanded
  // submenu would render "Loading…" forever (we'd never trigger the
  // fetch because the user didn't click).
  $effect(() => {
    if (!routeAgent || !routeSession) return;
    if (chat.sidebarPastSessions[routeAgent]) return;
    if (chat.sidebarLoadingSessions[routeAgent]) return;
    void loadPastSessions(routeAgent);
  });

  function pastFor(agent: AgentInfo): SidebarSessionSummary[] {
    const all = chat.sidebarPastSessions[agent.name] ?? [];
    // Drop the agent's currently-active session — that one is reached via the
    // parent row's primary click. Show only true past sessions here.
    return agent.sessionId ? all.filter((s) => s.sessionId !== agent.sessionId) : all;
  }

  function fmtSessionTs(ms: number): string {
    const d = new Date(ms);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const diff = now - ms;
    if (diff < dayMs)
      return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (diff < 7 * dayMs)
      return d.toLocaleDateString(undefined, { weekday: "short" });
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  let isMobile = $state(false);
  let open = $state(false);
  let rootEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => {
      isMobile = mq.matches;
      if (!isMobile) open = false;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  });

  $effect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootEl) return;
      if (!rootEl.contains(e.target as Node)) open = false;
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  });

  function navTo(href: string) {
    open = false;
    void goto(href);
  }
</script>

{#snippet agentRow(a: AgentInfo, isPinned: boolean)}
  <div
    class="row"
    class:pinned={isPinned}
    class:active={a.name === activeAgent}>
    <button
      class="row-main"
      title={isPinned ? "Friday" : `${a.type} · ${a.name}`}
      onclick={() => focusAgent(a.name, a.type)}>
      <span
        class="dot"
        class:pulse={a.status === "working"}
        style:background={statusDot(a.status)}
      ></span>
      {#if isPinned}
        <span class="agent-icon agent-orchestrator" aria-hidden="true">
          <DraftingCompass size={16} strokeWidth={2} />
        </span>
        <span class="name">Friday</span>
      {:else}
        {@const Icon = iconFor(a.type)}
        <span class="agent-icon agent-{a.type}" aria-hidden="true">
          <Icon size={16} strokeWidth={2} />
        </span>
        <span class="name">{a.name}</span>
      {/if}
      {#if (chat.unreadByAgent[a.name] ?? 0) > 0}
        <span
          class="unread"
          aria-label={`${chat.unreadByAgent[a.name]} unread`}>
          {chat.unreadByAgent[a.name]}
        </span>
      {/if}
    </button>
    {#if (a.sessionCount ?? 0) > 1 || (a.sessionCount === 1 && !a.sessionId)}
      <div class="expand-slot" class:open={isExpanded(a.name)} aria-hidden="true">
        <button
          type="button"
          class="expand-btn"
          aria-label={isExpanded(a.name) ? "Hide history" : "Show history"}
          aria-expanded={isExpanded(a.name) ? true : false}
          onclick={() => toggleHistory(a.name)}>
          {isExpanded(a.name) ? "−" : "+"}
        </button>
      </div>
    {/if}
  </div>
  {#if isExpanded(a.name)}
    <div class="history">
      {#if chat.sidebarLoadingSessions[a.name]}
        <div class="history-empty">Loading…</div>
      {:else if pastFor(a).length === 0}
        <div class="history-empty">No past sessions</div>
      {:else}
        {#each pastFor(a) as s}
          <button
            type="button"
            class="history-row"
            class:active={routeAgent === a.name && routeSession === s.sessionId}
            title={`${a.name} · ${new Date(s.lastTs).toLocaleString()} · ${s.turnCount} turn${s.turnCount === 1 ? "" : "s"}`}
            onclick={() => navTo(`/sessions/${a.name}/${s.sessionId}`)}>
            <span class="history-ts">{fmtSessionTs(s.lastTs)}</span>
            <span class="history-count">{s.turnCount} turn{s.turnCount === 1 ? "" : "s"}</span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet panelContents()}
  <div class="scrollable">
    {@render agentRow(pinned, true)}
    {#each bucketedOthers as group (group.key)}
      <div class="divider">{group.label}</div>
      {#each group.items as a (a.name)}
        {@render agentRow(a, false)}
      {/each}
    {/each}
  </div>
  <div class="filters">
    <Toggle
      block
      bind:checked={showArchived}
      label={archivedHidden > 0
        ? `Show archived (${archivedHidden})`
        : "Show archived"}
    />
    <Toggle
      block
      bind:checked={showInactive}
      label={inactiveHidden > 0
        ? `Show inactive (${inactiveHidden})`
        : "Show inactive"}
    />
  </div>
{/snippet}

<div class="sidebar" bind:this={rootEl} class:mobile={isMobile} class:open>
  {#if isMobile}
    <button
      type="button"
      class="trigger"
      aria-expanded={open}
      title={focused.type === "orchestrator"
        ? "Friday"
        : `${focused.type} · ${focused.name}`}
      onclick={() => (open = !open)}>
      <span
        class="dot"
        class:pulse={focused.status === "working"}
        style:background={statusDot(focused.status)}
      ></span>
      {#if focused.type === "orchestrator"}
        <span class="agent-icon agent-orchestrator" aria-hidden="true">
          <DraftingCompass size={16} strokeWidth={2} />
        </span>
        <span class="name">Friday</span>
      {:else}
        {@const Icon = iconFor(focused.type)}
        <span class="agent-icon agent-{focused.type}" aria-hidden="true">
          <Icon size={16} strokeWidth={2} />
        </span>
        <span class="name">{focused.name}</span>
      {/if}
      <span class="chev" aria-hidden="true">{open ? "−" : "+"}</span>
    </button>
    {#if open}
      <div class="dropdown">
        {@render panelContents()}
      </div>
    {/if}
  {:else}
    {@render panelContents()}
  {/if}
</div>

<style>
  /* Outer card.
     Desktop: fills the parent .chat-sidebar-floating, lays out as a column
     with the filter strip pinned at the bottom and the agents list scrolling
     above it. Mobile: just the trigger row; the panel becomes a popover. */
  .sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    box-sizing: border-box;
  }
  .sidebar.mobile {
    display: block;
    height: auto;
    position: relative;
    padding: 0.4rem;
  }

  .scrollable {
    flex: 1 1 0%;
    min-height: 0;
    overflow-y: auto;
    padding: 0.6rem 0.6rem;
  }

  .filters {
    flex-shrink: 0;
    border-top: 1px solid var(--border-subtle);
    padding: 0.5rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    background: var(--bg-card);
    border-bottom-left-radius: var(--radius-lg);
    border-bottom-right-radius: var(--radius-lg);
  }

  /* Whole row is the visual unit — its background tracks hover/active so
     both .row-main and .expand-btn sit inside the same highlight. The
     expand-btn is positioned absolutely on top of the row so the label
     can use the full row width and ellide naturally; the button reveals
     itself on hover/focus/expanded/touch as a right-edge overlay with a
     gradient fade that matches whichever state the row is currently in.
     --row-bg is the single source of truth for that match. */
  .row {
    position: relative;
    display: flex;
    align-items: stretch;
    margin-bottom: 0.2rem;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    --row-bg: var(--bg-card);
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .row:hover,
  .row:focus-within {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    --row-bg: var(--bg-tertiary);
  }
  .row.active,
  .row.active:hover,
  .row.active:focus-within {
    background: var(--accent-glow);
    color: var(--accent-primary);
    /* --accent-glow is semi-transparent (~0.12 dark / 0.15 light) so it
       reads as a tint OF the panel underneath. The slot can't reuse
       --accent-glow directly — painting it again on top of the row's
       accent-glow doubles the alpha and produces a darker patch where
       the +/- overlay sits. Use a pre-flattened opaque equivalent
       (panel bg + ~13% accent-primary) that visually matches the row's
       rendered colour without stacking. */
    --row-bg:
      color-mix(in srgb, var(--bg-card), var(--accent-primary) 13%);
  }
  .row-main {
    flex: 1;
    min-width: 0;
    text-align: left;
    background: transparent;
    border: none;
    padding: 0.5rem 0.7rem;
    display: flex;
    align-items: center;
    gap: 0.55rem;
    color: inherit;
    min-height: 40px;
    font-size: 0.85rem;
    cursor: pointer;
    font-family: inherit;
  }
  .row.pinned .row-main { font-weight: 600; }
  .row.pinned .name { font-family: var(--font-sans); }

  /* Slot owns the gradient fade and the reveal opacity; pointer-events
     are off so clicks in the empty fade zone fall through to .row-main
     (i.e. clicking near the glyph still navigates to the agent). The
     glyph button inside re-enables pointer events and is the only
     tabbable / clickable target — its focus ring hugs just the glyph,
     not the whole 3rem fade area. */
  .expand-slot {
    position: absolute;
    top: 50%;
    right: 0;
    transform: translateY(-50%);
    /* Wider than the button itself so there's a meaningful opaque plate
       around the glyph (the +/- never sits over translucent label text),
       with the gradient fade strictly to the left of that plate. ~40%
       fade + ~60% solid row-bg gives the button a substantial backing
       even when the underlying label runs long. */
    width: 4rem;
    height: 1.85rem;
    padding-right: 0.35rem;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    pointer-events: none;
    background:
      linear-gradient(
        to right,
        transparent 0%,
        var(--row-bg) 40%,
        var(--row-bg) 100%
      );
    opacity: 0;
    transition: opacity var(--transition-fast);
  }
  .row:hover .expand-slot,
  .row:focus-within .expand-slot,
  .expand-slot.open {
    opacity: 1;
  }
  /* Always-visible on touch devices — slot reveals; button is the click
     target as usual. */
  @media (hover: none) {
    .expand-slot { opacity: 1; }
  }

  .expand-btn {
    pointer-events: auto;
    width: 1.85rem;
    height: 1.85rem;
    background: transparent;
    border: none;
    color: inherit;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 1.2rem;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background var(--transition-fast);
  }
  /* Button-itself affordance: a small solid plate over the slot bg so
     the glyph reads as its own click target. Same plate fires on mouse
     hover and keyboard focus so tabbed-in state visually matches the
     pointer hover state. */
  .expand-btn:hover,
  .expand-btn:focus-visible {
    background: color-mix(in srgb, var(--row-bg) 60%, var(--text-primary) 16%);
  }

  .history {
    margin: 0 0 0.4rem 1.4rem;
    padding-left: 0.5rem;
    border-left: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .history-empty {
    color: var(--text-tertiary);
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
  }
  .history-row {
    background: transparent;
    border: none;
    text-align: left;
    padding: 0.35rem 0.6rem;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.78rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .history-row:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }
  .history-row.active {
    background: var(--accent-glow);
    color: var(--accent-primary);
  }
  .history-ts {
    font-family: var(--font-mono);
    color: var(--text-tertiary);
  }
  .history-count {
    margin-left: auto;
    font-size: 0.7rem;
    color: var(--text-tertiary);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  /* Working agents pulse a soft outer ring so the live state reads at a
     glance — a static colored dot is too easy to miss against the row
     hover/active backgrounds. The dot's own color comes from `statusDot`,
     so the ring uses `currentColor` indirectly via the box-shadow color. */
  .dot.pulse {
    box-shadow: 0 0 0 0 var(--status-ok);
    animation: dot-pulse 1.6s ease-out infinite;
  }
  @keyframes dot-pulse {
    0% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-ok) 70%, transparent);
    }
    70% {
      box-shadow: 0 0 0 6px color-mix(in srgb, var(--status-ok) 0%, transparent);
    }
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-ok) 0%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.pulse { animation: none; }
  }
  /* Typed agent glyph. Lucide icon centred in a fixed-size box so rows align
     even when an agent's type rolls over (the glyph swaps; the column stays
     put). Color comes from per-type CSS vars in app.css; both light and dark
     palettes are defined there. */
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
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
  }
  /* Unread badge — small pill on the right edge of the row when the agent
     has produced user-visible content while another agent was focused.
     FIX_FORWARD 3.6. */
  .unread {
    flex-shrink: 0;
    font-size: 0.65rem;
    font-weight: 600;
    padding: 0.1rem 0.4rem;
    border-radius: 99px;
    background: var(--accent-primary, var(--status-ok));
    color: var(--accent-on-bg, white);
    font-family: var(--font-mono);
    min-width: 1.2rem;
    text-align: center;
  }
  .divider {
    color: var(--text-tertiary);
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
    padding: 0.9rem 0.7rem 0.35rem;
  }

  /* Mobile trigger + popover. */
  .trigger {
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    padding: 0.5rem 0.7rem;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    gap: 0.55rem;
    color: var(--text-primary);
    min-height: 40px;
    font-size: 0.85rem;
    cursor: pointer;
    font-family: inherit;
    font-weight: 600;
  }
  .trigger:hover {
    background: var(--bg-tertiary);
  }
  .trigger .name { font-family: var(--font-sans); }
  .chev {
    margin-left: auto;
    color: var(--text-tertiary);
    font-size: 0.75rem;
  }
  .dropdown {
    position: absolute;
    top: calc(100% + 0.4rem);
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    /* Cap to viewport height minus header offset and a margin. The agents
       list above scrolls; the filters strip stays pinned at the bottom. */
    max-height: calc(100vh - 8rem);
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    z-index: 20;
  }
</style>
