<script lang="ts">
  import type { PageData } from "./$types";
  import type { ScheduleRow } from "./+page.server";
  import { nextRuns } from "@friday/shared/cron";
  import { confirmDialog } from "$lib/components/ConfirmDialog/store.svelte";
  import {
    useZero,
    zeroSync,
    type ZeroScheduleRow,
  } from "$lib/stores/zero.svelte";
  import { filterReminders, upcomingReminders } from "./reminders";

  let { data }: { data: PageData } = $props();

  // Phase 3.2 (ADR-024): when the Zero flag is on the schedules list
  // is sourced from `zeroSync.schedules`. Same pattern as the tickets
  // slice — keep `schedules` as a mutable $state so downstream call
  // sites (refresh, mutation handlers) stay untouched, and push Zero
  // rows in via an $effect when the flag is on.
  const zeroOn = useZero();
  // svelte-ignore state_referenced_locally
  let schedules = $state<ScheduleRow[]>(data.schedules);
  $effect(() => {
    if (zeroOn) {
      schedules = zeroSync.schedules.map(toScheduleRow);
    }
  });
  function toScheduleRow(r: ZeroScheduleRow): ScheduleRow {
    return {
      name: r.name,
      cron: r.cron,
      runAt: r.run_at,
      taskPrompt: r.task_prompt,
      paused: r.paused,
      kind: r.kind,
      nextRunAt: r.next_run_at,
      lastRunAt: r.last_run_at,
      lastRunId: r.last_run_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  // FRI-168: reminder surface. `view` toggles the table between all
  // schedules and reminders-only; `upcoming` drives the agenda panel.
  let view = $state<"all" | "reminders">("all");
  const visibleSchedules = $derived(
    view === "reminders" ? filterReminders(schedules) : schedules,
  );
  const upcoming = $derived(upcomingReminders(schedules, Date.now()));

  let busy = $state<string | null>(null);
  let toast = $state<{ msg: string; kind: "ok" | "err" | "info" } | null>(null);

  function showToast(msg: string, kind: "ok" | "err" | "info" = "ok") {
    toast = { msg, kind };
    setTimeout(() => {
      toast = null;
    }, 4500);
  }

  function fmtTs(ms: number | null): string {
    return ms ? new Date(ms).toLocaleString() : "—";
  }

  function fmtRelative(ms: number | null): string {
    if (!ms) return "—";
    const delta = ms - Date.now();
    const abs = Math.abs(delta);
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    let val: string;
    if (abs < minute) val = "<1m";
    else if (abs < hour) val = `${Math.round(abs / minute)}m`;
    else if (abs < day) val = `${Math.round(abs / hour)}h`;
    else val = `${Math.round(abs / day)}d`;
    return delta > 0 ? `in ${val}` : `${val} ago`;
  }

  function nextFiresPreview(cron: string | null): string[] {
    if (!cron) return [];
    return nextRuns(cron, 5).map((d) => d.toLocaleString());
  }

  async function refresh() {
    // Phase 3.2: under the Zero flag the reactive query keeps schedules
    // in sync without a manual REST hit.
    if (zeroOn) return;
    try {
      const r = await fetch("/api/schedules");
      if (!r.ok) return;
      schedules = (await r.json()) as ScheduleRow[];
    } catch {
      // ignore
    }
  }

  async function action(
    name: string,
    label: "pause" | "resume" | "trigger",
    past: string,
    path: string,
  ) {
    if (busy) return;
    busy = `${label} ${name}`;
    try {
      if (zeroOn) {
        // Item #53: pause/resume/trigger as mutators. The Zero path
        // dispatches the matching mutator + the daemon LISTEN
        // handler (or the scheduler's tick(), for pure-data pause)
        // applies the side effect. Replaces the REST POSTs.
        const result =
          label === "pause"
            ? zeroSync.pauseSchedule({ name })
            : label === "resume"
              ? zeroSync.resumeSchedule({ name })
              : zeroSync.triggerSchedule({ name });
        const sr = await result?.server;
        if (sr && sr.type === "error") {
          showToast(`${label} failed: ${sr.error.message}`, "err");
          return;
        }
        showToast(`${past} ${name}`);
        return;
      }
      const r = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) {
        const detail =
          typeof body.detail === "string" ? body.detail : `${r.status}`;
        showToast(`${label} failed: ${detail}`, "err");
        return;
      }
      const runId = typeof body.runId === "string" ? body.runId : null;
      showToast(runId ? `${past} ${name} (run ${runId})` : `${past} ${name}`);
      await refresh();
    } finally {
      busy = null;
    }
  }

  async function deleteSchedule(name: string) {
    const ok = await confirmDialog({
      title: `Delete schedule "${name}"?`,
      description: `This removes the row but leaves ~/.friday/schedules/${name}/ on disk so state.md isn't lost.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    busy = `delete ${name}`;
    try {
      if (zeroOn) {
        // Phase 4.6: soft-delete via Zero mutator. Reactive query
        // filters status='deleted' so the row disappears
        // immediately from the list (optimistic).
        const result = zeroSync.deleteSchedule({ name });
        const sr = await result?.server;
        if (sr && sr.type === "error") {
          showToast(`delete failed: ${sr.error.message}`, "err");
          return;
        }
        showToast(`deleted ${name}`);
        return;
      }
      const r = await fetch(`/api/schedules/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        showToast(`delete failed (${r.status})`, "err");
        return;
      }
      showToast(`deleted ${name}`);
      await refresh();
    } finally {
      busy = null;
    }
  }
</script>

<header class="page-head">
  <h1>Schedules</h1>
  <p class="page-lead">Cron-driven scheduled agents and their run history.</p>
</header>

<div class="card">
  <div class="card-header">
    <h2>Upcoming reminders</h2>
    <span class="stat-detail">next 7 days</span>
  </div>
  {#if upcoming.length === 0}
    <p class="empty-state">No upcoming reminders.</p>
  {:else}
    <ul class="upcoming-list">
      {#each upcoming as r (r.name)}
        <li class="upcoming-item">
          <a class="link-strong" href="/schedules/{encodeURIComponent(r.name)}"
            >{r.taskPrompt || r.name}</a>
          <span class="upcoming-when">
            {fmtTs(r.nextRunAt)}
            <span class="muted text-xs">{fmtRelative(r.nextRunAt)}</span>
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<div class="card">
  <div class="card-header">
    <h2>All schedules</h2>
    <div class="card-header-controls">
      <div class="view-toggle" role="group" aria-label="Filter schedules">
        <button
          class="ghost compact"
          class:active={view === "all"}
          aria-pressed={view === "all"}
          onclick={() => (view = "all")}>
          All
        </button>
        <button
          class="ghost compact"
          class:active={view === "reminders"}
          aria-pressed={view === "reminders"}
          onclick={() => (view = "reminders")}>
          Reminders
        </button>
      </div>
      <span class="stat-detail">{visibleSchedules.length} total</span>
    </div>
  </div>
  {#if visibleSchedules.length === 0}
    <p class="empty-state">
      {view === "reminders" ? "No reminders." : "No schedules."}
    </p>
  {:else}
    <div class="table-scroll-wrapper">
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Kind</th>
          <th>Cron / At</th>
          <th>Status</th>
          <th>Next run</th>
          <th>Last run</th>
          <th aria-label="Actions"></th>
        </tr>
      </thead>
      <tbody>
        {#each visibleSchedules as s (s.name)}
          {@const fires = nextFiresPreview(s.cron)}
          <tr>
            <td>
              <a class="link-strong" href="/schedules/{encodeURIComponent(s.name)}"
                >{s.name}</a>
            </td>
            <td>
              {#if s.kind === "reminder"}
                <span class="badge info">reminder</span>
              {:else}
                <span class="badge">agent-run</span>
              {/if}
            </td>
            <td>
              {#if s.cron}
                <code class="text-mono">{s.cron}</code>
                {#if fires.length > 0}
                  <details class="fires">
                    <summary>Next {fires.length} fires</summary>
                    <ul>
                      {#each fires as f (f)}<li>{f}</li>{/each}
                    </ul>
                  </details>
                {/if}
              {:else if s.runAt}
                <span class="text-mono">{s.runAt}</span>
              {:else}
                —
              {/if}
            </td>
            <td>
              {#if s.paused}
                <span class="badge warn">paused</span>
              {:else}
                <span class="badge ok">active</span>
              {/if}
            </td>
            <td>
              <div>{fmtTs(s.nextRunAt)}</div>
              <div class="muted text-xs">{fmtRelative(s.nextRunAt)}</div>
            </td>
            <td>
              <div>{fmtTs(s.lastRunAt)}</div>
              {#if s.lastRunId}
                <div class="muted text-xs text-mono">{s.lastRunId}</div>
              {/if}
            </td>
            <td class="actions-cell">
              <div class="actions-row">
                {#if s.paused}
                  <button
                    class="ghost compact"
                    onclick={() =>
                      action(
                        s.name,
                        "resume",
                        "resumed",
                        `/api/schedules/${encodeURIComponent(s.name)}/resume`,
                      )}
                    disabled={busy !== null}>
                    Resume
                  </button>
                {:else}
                  <button
                    class="ghost compact"
                    onclick={() =>
                      action(
                        s.name,
                        "pause",
                        "paused",
                        `/api/schedules/${encodeURIComponent(s.name)}/pause`,
                      )}
                    disabled={busy !== null}>
                    Pause
                  </button>
                {/if}
                <button
                  class="ghost compact"
                  onclick={() =>
                    action(
                      s.name,
                      "trigger",
                      "triggered",
                      `/api/schedules/${encodeURIComponent(s.name)}/trigger`,
                    )}
                  disabled={busy !== null}>
                  Trigger
                </button>
                <button
                  class="ghost compact danger"
                  onclick={() => deleteSchedule(s.name)}
                  disabled={busy !== null}>
                  Delete
                </button>
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    </div>
  {/if}
</div>

{#if toast}
  <div class="toast toast-{toast.kind}" role="status" aria-live="polite">
    {toast.msg}
  </div>
{/if}

<style>
  .link-strong {
    color: var(--text-primary);
    text-decoration: none;
    font-weight: 600;
    font-family: var(--font-mono);
    font-size: 0.85rem;
  }
  .link-strong:hover {
    color: var(--accent-primary);
  }
  .text-mono {
    font-family: var(--font-mono);
    font-size: 0.8rem;
  }
  .text-xs {
    font-size: 0.7rem;
  }
  .muted {
    color: var(--text-tertiary);
  }
  .actions-cell {
    text-align: right;
    white-space: nowrap;
  }
  .actions-row {
    display: inline-flex;
    gap: 0.3rem;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .ghost.compact {
    font-size: 0.75rem;
    padding: 0.25rem 0.55rem;
  }
  .ghost.compact.active {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }
  .card-header-controls {
    display: inline-flex;
    align-items: center;
    gap: 0.75rem;
  }
  .view-toggle {
    display: inline-flex;
    gap: 0.3rem;
  }
  .upcoming-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .upcoming-item {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--border-subtle);
  }
  .upcoming-item:last-child {
    border-bottom: none;
  }
  .upcoming-when {
    display: inline-flex;
    align-items: baseline;
    gap: 0.4rem;
    white-space: nowrap;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }
  .fires {
    margin-top: 0.3rem;
    font-size: 0.75rem;
  }
  .fires summary {
    cursor: pointer;
    color: var(--text-tertiary);
  }
  .fires ul {
    margin: 0.3rem 0 0;
    padding: 0 0 0 1rem;
    color: var(--text-secondary);
  }
  .toast {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    padding: 0.6rem 0.9rem;
    border-radius: var(--radius-sm);
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    box-shadow: var(--shadow-md);
    font-size: 0.85rem;
    z-index: 50;
    max-width: min(420px, 90vw);
  }
  .toast-ok {
    border-color: var(--status-success);
  }
  .toast-err {
    border-color: var(--status-error);
    color: var(--status-error);
  }
  .toast-info {
    border-color: var(--accent-primary);
  }
</style>
