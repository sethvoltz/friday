<script lang="ts">
  import type { ScheduledEntry } from "@friday/shared";
  import { getLiveStatus } from "$lib/events.svelte";
  import Markdown from "$lib/Markdown.svelte";
  import { onMount } from "svelte";

  let { data } = $props();
  const name: string = $derived(data.name);
  const entry: ScheduledEntry = $derived(data.entry);
  const stateContent: string | null = $derived(data.stateContent);
  const lastRunContent: string | null = $derived(data.lastRunContent);

  const effectiveStatus = $derived(getLiveStatus(name) ?? entry.status);

  // Tick every 30s so relative times stay fresh
  let now = $state(Date.now());
  onMount(() => {
    const interval = setInterval(() => { now = Date.now(); }, 30_000);
    return () => clearInterval(interval);
  });

  function fmtDate(d: string | null): string {
    if (!d) return "never";
    return new Date(d).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function fmtRelative(d: string | null): string {
    if (!d) return "";
    const ms = new Date(d).getTime() - now;
    if (ms < 0) {
      const ago = Math.abs(ms);
      const mins = Math.floor(ago / 60_000);
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      const days = Math.floor(hrs / 24);
      return `${days}d ago`;
    }
    const mins = Math.floor(ms / 60_000);
    if (mins < 60) return `in ${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `in ${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `in ${days}d`;
  }

  function scheduleDescription(entry: ScheduledEntry): string {
    if (entry.schedule.cron) {
      let desc = entry.schedule.cron;
      if (entry.schedule.timezone) desc += ` (${entry.schedule.timezone})`;
      return desc;
    }
    if (entry.schedule.runAt) return `one-shot: ${fmtDate(entry.schedule.runAt)}`;
    return "unknown";
  }

  function statusLabel(status: string, paused: boolean): string {
    if (status === "destroyed") return "destroyed";
    if (paused) return "paused";
    return status;
  }

  function statusClass(status: string, paused: boolean): string {
    if (status === "destroyed") return "badge-destroyed";
    if (paused) return "badge-paused";
    if (status === "active") return "badge-active";
    return "badge-idle";
  }
</script>

<div class="schedule-detail">
  <header class="detail-header">
    <div class="header-top">
      <h2>{name}</h2>
      <span class="status-badge {statusClass(effectiveStatus, entry.paused)}">
        {statusLabel(effectiveStatus, entry.paused)}
      </span>
    </div>

    <div class="meta-grid">
      <div class="meta-item">
        <span class="meta-label">Schedule</span>
        <span class="meta-value mono">{scheduleDescription(entry)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Last run</span>
        <span class="meta-value">{fmtDate(entry.lastRunAt)} {entry.lastRunAt ? fmtRelative(entry.lastRunAt) : ''}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Next run</span>
        <span class="meta-value">{fmtDate(entry.nextRunAt)} {entry.nextRunAt ? fmtRelative(entry.nextRunAt) : ''}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Created</span>
        <span class="meta-value">{fmtDate(entry.createdAt)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Working dir</span>
        <span class="meta-value mono">{entry.cwd}</span>
      </div>
      {#if entry.sessionId}
        <div class="meta-item">
          <span class="meta-label">Session</span>
          <span class="meta-value mono">{entry.sessionId}</span>
        </div>
      {/if}
    </div>

    <div class="task-prompt">
      <span class="meta-label">Task</span>
      <div class="task-text"><Markdown source={entry.taskPrompt} /></div>
    </div>
  </header>

  <div class="detail-body">
    {#if lastRunContent}
      <section class="state-section">
        <h3>Last Run</h3>
        <div class="state-content"><Markdown source={lastRunContent} /></div>
      </section>
    {/if}

    {#if stateContent}
      <section class="state-section">
        <h3>Run State</h3>
        <div class="state-content"><Markdown source={stateContent} /></div>
      </section>
    {/if}

    {#if !stateContent && !lastRunContent}
      <div class="no-state">
        <p>No run data yet. This schedule has not been triggered.</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .schedule-detail {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .detail-header {
    padding: 1rem 0 1rem;
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .header-top {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .header-top h2 {
    margin: 0;
    font-size: 1.2rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .status-badge {
    font-size: 0.7rem;
    font-weight: 500;
    padding: 0.15rem 0.5rem;
    border-radius: 99px;
  }
  .badge-active { background: color-mix(in srgb, var(--status-ok) 15%, transparent); color: var(--status-ok); }
  .badge-idle { background: var(--bg-tertiary); color: var(--text-secondary); }
  .badge-paused { background: color-mix(in srgb, var(--status-warn, #f59e0b) 15%, transparent); color: var(--status-warn, #f59e0b); }
  .badge-destroyed { background: var(--bg-tertiary); color: var(--text-tertiary); }

  .meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 0.5rem 1.5rem;
    margin-bottom: 0.75rem;
  }

  .meta-item {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .meta-label {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-tertiary);
  }

  .meta-value {
    font-size: 0.8rem;
    color: var(--text-primary);
  }

  .meta-value.mono {
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }

  .task-prompt {
    margin-top: 0.25rem;
  }

  .task-text {
    margin: 0.25rem 0 0;
    max-width: 65ch;
  }

  .detail-body {
    flex: 1;
    overflow-y: auto;
    padding: 1.25rem 0;
  }

  .state-section {
    margin-bottom: 1.5rem;
  }

  .state-section h3 {
    margin: 0 0 0.5rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .state-content {
    margin: 0;
    padding: 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    max-width: 80ch;
  }

  .no-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 60%;
    color: var(--text-tertiary);
    font-size: 0.85rem;
  }
  .no-state p {
    margin: 0;
  }
</style>
