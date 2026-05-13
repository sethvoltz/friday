<script lang="ts">
  import { chat, type AgentInfo } from "$lib/stores/chat.svelte";
  import { goto } from "$app/navigation";
  import Toggle from "$lib/components/Toggle/Toggle.svelte";
  import { loadJSON, saveJSON } from "$lib/stores/persistent";
  import { onMount } from "svelte";

  interface SessionSummary {
    sessionId: string;
    firstTs: number;
    lastTs: number;
    turnCount: number;
  }

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
        // F2-D: always show the focused row, regardless of the filter
        // state — the user is reading that agent's chat in the main
        // pane, so losing the sidebar row when the agent gets archived
        // mid-view is a UX cliff.
        if (a.name === chat.focusedAgent) return true;
        if (a.status === "archived") return showArchived;
        if (!isActive(a.status)) return showInactive;
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
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

  // Per-agent expanded-history state.
  let expanded = $state<Record<string, boolean>>({});
  let pastSessions = $state<Record<string, SessionSummary[]>>({});
  let loadingSessions = $state<Record<string, boolean>>({});

  async function toggleHistory(name: string) {
    expanded[name] = !expanded[name];
    if (expanded[name] && !pastSessions[name] && !loadingSessions[name]) {
      loadingSessions[name] = true;
      try {
        const r = await fetch(`/api/agents/${name}/sessions`);
        if (r.ok) {
          pastSessions[name] = (await r.json()) as SessionSummary[];
        }
      } finally {
        loadingSessions[name] = false;
      }
    }
  }

  function pastFor(agent: AgentInfo): SessionSummary[] {
    const all = pastSessions[agent.name] ?? [];
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
    class:active={chat.focusedAgent === a.name}>
    <button class="row-main" onclick={() => focusAgent(a.name, a.type)}>
      <span
        class="dot"
        class:pulse={a.status === "working"}
        style:background={statusDot(a.status)}
      ></span>
      {#if isPinned}
        <span class="crown">👑</span>
        <span class="name">Friday</span>
      {:else}
        <span class="type">{a.type}</span>
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
      <button
        type="button"
        class="expand-btn"
        class:open={expanded[a.name]}
        aria-label={expanded[a.name] ? "Hide history" : "Show history"}
        aria-expanded={expanded[a.name] ? true : false}
        onclick={() => toggleHistory(a.name)}>
        {expanded[a.name] ? "−" : "+"}
      </button>
    {/if}
  </div>
  {#if expanded[a.name]}
    <div class="history">
      {#if loadingSessions[a.name]}
        <div class="history-empty">Loading…</div>
      {:else if pastFor(a).length === 0}
        <div class="history-empty">No past sessions</div>
      {:else}
        {#each pastFor(a) as s}
          <button
            type="button"
            class="history-row"
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
    {#if others.length > 0}
      <div class="divider">Active agents</div>
      {#each others as a (a.name)}
        {@render agentRow(a, false)}
      {/each}
    {/if}
  </div>
  <div class="filters">
    <Toggle block bind:checked={showArchived} label="Show archived" />
    <Toggle block bind:checked={showInactive} label="Show inactive" />
  </div>
{/snippet}

<div class="sidebar" bind:this={rootEl} class:mobile={isMobile} class:open>
  {#if isMobile}
    <button
      type="button"
      class="trigger"
      aria-expanded={open}
      onclick={() => (open = !open)}>
      <span
        class="dot"
        class:pulse={focused.status === "working"}
        style:background={statusDot(focused.status)}
      ></span>
      {#if focused.type === "orchestrator"}
        <span class="crown">👑</span>
        <span class="name">Friday</span>
      {:else}
        <span class="type">{focused.type}</span>
        <span class="name">{focused.name}</span>
      {/if}
      <span class="chev" aria-hidden="true">{open ? "▴" : "▾"}</span>
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
     both .row-main and .expand-btn sit inside the same highlight. The two
     children are transparent. */
  .row {
    display: flex;
    align-items: stretch;
    margin-bottom: 0.2rem;
    padding-right: 0.35rem;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .row:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }
  .row.active {
    background: var(--accent-glow);
    color: var(--accent-primary);
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

  .expand-btn {
    flex-shrink: 0;
    align-self: center;
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
    opacity: 0;
    transition: opacity var(--transition-fast), background var(--transition-fast);
  }
  .row:hover .expand-btn,
  .expand-btn.open {
    opacity: 1;
  }
  .expand-btn:hover {
    background: var(--bg-card);
  }
  /* Always-visible expand button on touch devices. */
  @media (hover: none) {
    .expand-btn { opacity: 1; }
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
  .crown { font-size: 1rem; }
  .type {
    font-size: 0.62rem;
    color: var(--text-tertiary);
    padding: 0.1rem 0.4rem;
    border-radius: 99px;
    background: var(--bg-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    font-family: var(--font-mono);
  }
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
