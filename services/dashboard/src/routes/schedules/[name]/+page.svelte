<script lang="ts">
  import type { PageData } from "./$types";
  import { isValidCron, nextRuns } from "@friday/shared";
  import { invalidateAll, goto } from "$app/navigation";

  let { data }: { data: PageData } = $props();

  // svelte-ignore state_referenced_locally
  let cron = $state(data.schedule.cron ?? "");
  // svelte-ignore state_referenced_locally
  let runAt = $state(data.schedule.runAt ?? "");
  // svelte-ignore state_referenced_locally
  let taskPrompt = $state(data.schedule.taskPrompt);
  let saving = $state(false);
  let toast = $state<{ msg: string; kind: "ok" | "err" | "info" } | null>(null);

  let cronValid = $derived(cron.trim() === "" || isValidCron(cron.trim()));
  let fires = $derived(
    cron.trim() && cronValid
      ? nextRuns(cron.trim(), 5).map((d) => d.toLocaleString())
      : [],
  );
  let dirty = $derived(
    cron !== (data.schedule.cron ?? "") ||
      runAt !== (data.schedule.runAt ?? "") ||
      taskPrompt !== data.schedule.taskPrompt,
  );

  function showToast(msg: string, kind: "ok" | "err" | "info" = "ok") {
    toast = { msg, kind };
    setTimeout(() => {
      toast = null;
    }, 4500);
  }

  async function save() {
    if (!cronValid) {
      showToast("invalid cron expression", "err");
      return;
    }
    if (!taskPrompt.trim()) {
      showToast("task prompt is required", "err");
      return;
    }
    saving = true;
    try {
      const r = await fetch("/api/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: data.schedule.name,
          cron: cron.trim() || undefined,
          runAt: runAt.trim() || undefined,
          taskPrompt,
          paused: data.schedule.paused,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as {
          detail?: string;
        };
        showToast(body.detail ?? `save failed (${r.status})`, "err");
        return;
      }
      showToast("saved");
      await invalidateAll();
    } finally {
      saving = false;
    }
  }

  async function trigger() {
    const r = await fetch(
      `/api/schedules/${encodeURIComponent(data.schedule.name)}/trigger`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    if (r.ok) {
      const body = (await r.json()) as { runId?: string };
      showToast(`triggered (run ${body.runId ?? "?"})`);
      await invalidateAll();
    } else {
      showToast(`trigger failed (${r.status})`, "err");
    }
  }

  async function pauseResume() {
    const verb = data.schedule.paused ? "resume" : "pause";
    const r = await fetch(
      `/api/schedules/${encodeURIComponent(data.schedule.name)}/${verb}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    if (r.ok) {
      showToast(`${verb}d`);
      await invalidateAll();
    } else {
      showToast(`${verb} failed (${r.status})`, "err");
    }
  }

  async function deleteSchedule() {
    if (
      !confirm(
        `Delete schedule "${data.schedule.name}"? The row is removed; state.md / last-run.md stay on disk.`,
      )
    )
      return;
    const r = await fetch(
      `/api/schedules/${encodeURIComponent(data.schedule.name)}`,
      { method: "DELETE" },
    );
    if (r.ok) {
      await goto("/schedules");
    } else {
      showToast(`delete failed (${r.status})`, "err");
    }
  }

  function fmtTs(ms: number | null) {
    return ms ? new Date(ms).toLocaleString() : "—";
  }
</script>

<header class="page-head">
  <h1>
    <a class="back" href="/schedules">Schedules</a>
    <span class="separator">›</span>
    <code class="text-mono">{data.schedule.name}</code>
  </h1>
  <p class="page-lead">Cron, prompt, and continuity state.</p>
</header>

<div class="grid">
  <div class="card">
    <div class="card-header"><h2>Status</h2></div>
    <div class="row">
      <span class="row-label">State</span>
      <span class="row-value">
        {#if data.schedule.paused}
          <span class="badge warn">paused</span>
        {:else}
          <span class="badge ok">active</span>
        {/if}
      </span>
    </div>
    <div class="row">
      <span class="row-label">Next run</span>
      <span class="row-value">{fmtTs(data.schedule.nextRunAt)}</span>
    </div>
    <div class="row">
      <span class="row-label">Last run</span>
      <span class="row-value">{fmtTs(data.schedule.lastRunAt)}</span>
    </div>
    {#if data.schedule.lastRunId}
      <div class="row">
        <span class="row-label">Last run id</span>
        <span class="row-value text-mono">{data.schedule.lastRunId}</span>
      </div>
    {/if}
    <div class="actions">
      <button class="ghost" onclick={pauseResume}>
        {data.schedule.paused ? "Resume" : "Pause"}
      </button>
      <button class="ghost" onclick={trigger}>Trigger now</button>
      <button class="ghost danger" onclick={deleteSchedule}>Delete</button>
    </div>
  </div>

  <div class="card edit-card">
    <div class="card-header">
      <h2>Edit</h2>
      {#if dirty}<span class="dirty-dot">unsaved</span>{/if}
    </div>
    <label class="field">
      <span class="row-label">Cron (UTC, 5-field)</span>
      <input
        class="input text-mono"
        type="text"
        placeholder="0 4 * * *"
        bind:value={cron} />
      {#if cron.trim() && !cronValid}
        <span class="field-err">invalid cron expression</span>
      {/if}
    </label>
    <label class="field">
      <span class="row-label">One-shot run-at (ISO)</span>
      <input
        class="input text-mono"
        type="text"
        placeholder="2026-06-01T08:00:00Z"
        bind:value={runAt} />
      <span class="field-hint">
        Leave cron blank and set this for a one-shot scheduled run.
      </span>
    </label>
    <label class="field">
      <span class="row-label">Task prompt</span>
      <textarea class="textarea" rows="14" bind:value={taskPrompt}></textarea>
    </label>
    {#if fires.length > 0}
      <div class="fires-preview">
        <div class="row-label">Next 5 fires</div>
        <ul>
          {#each fires as f (f)}<li>{f}</li>{/each}
        </ul>
      </div>
    {/if}
    <div class="actions">
      <button
        class="ghost primary"
        onclick={save}
        disabled={saving || !dirty || !cronValid}>
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  </div>

  <div class="card wide">
    <div class="card-header"><h2>state.md</h2></div>
    {#if data.artifacts.state}
      <pre class="md-preview">{data.artifacts.state}</pre>
    {:else}
      <p class="empty-state">
        No <code>state.md</code> yet. The scheduled agent writes this on its first run; it
        carries continuity into the next fire.
      </p>
    {/if}
  </div>

  <div class="card wide">
    <div class="card-header"><h2>last-run.md</h2></div>
    {#if data.artifacts.lastRun}
      <pre class="md-preview">{data.artifacts.lastRun}</pre>
    {:else}
      <p class="empty-state">
        No <code>last-run.md</code> yet. The daemon writes this on worker exit; it records
        timestamp, status, duration, and session id.
      </p>
    {/if}
  </div>
</div>

{#if toast}
  <div class="toast toast-{toast.kind}" role="status" aria-live="polite">
    {toast.msg}
  </div>
{/if}

<style>
  .back {
    color: var(--text-secondary);
    text-decoration: none;
    font-weight: 500;
  }
  .back:hover {
    color: var(--accent-primary);
  }
  .separator {
    color: var(--text-tertiary);
    margin: 0 0.3rem;
  }
  .text-mono {
    font-family: var(--font-mono);
  }
  .row {
    display: flex;
    justify-content: space-between;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 0.85rem;
  }
  .row:last-of-type {
    border-bottom: none;
  }
  .row-label {
    color: var(--text-tertiary);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .row-value {
    color: var(--text-primary);
  }
  .actions {
    margin-top: 1rem;
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  button.danger {
    color: var(--status-error);
  }
  button.primary {
    color: var(--accent-primary);
    border-color: var(--accent-primary);
  }
  .edit-card {
    display: flex;
    flex-direction: column;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-top: 0.75rem;
  }
  .input,
  .textarea {
    width: 100%;
    padding: 0.5rem 0.6rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    font-family: inherit;
  }
  .textarea {
    font-family: var(--font-mono);
    resize: vertical;
    min-height: 200px;
  }
  .field-hint {
    color: var(--text-tertiary);
    font-size: 0.7rem;
  }
  .field-err {
    color: var(--status-error);
    font-size: 0.75rem;
  }
  .fires-preview {
    margin-top: 0.75rem;
    padding: 0.6rem;
    background: var(--bg-secondary);
    border-radius: var(--radius-sm);
    font-size: 0.78rem;
  }
  .fires-preview ul {
    margin: 0.3rem 0 0;
    padding-left: 1rem;
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }
  .dirty-dot {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent-primary);
  }
  .wide {
    grid-column: 1 / -1;
  }
  .md-preview {
    margin: 0.5rem 0 0;
    padding: 0.7rem;
    background: var(--bg-code);
    border-radius: var(--radius-sm);
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    max-height: 380px;
    overflow: auto;
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
