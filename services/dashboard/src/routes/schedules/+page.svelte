<script lang="ts">
  import type { PageData } from "./$types";

  interface Schedule {
    name: string;
    cron: string | null;
    runAt: string | null;
    paused: boolean;
    nextRunAt: number | null;
    lastRunAt: number | null;
  }

  let { data }: { data: PageData } = $props();
  let schedules = $derived(data.schedules as Schedule[]);

  function fmtTs(ms: number | null) {
    return ms ? new Date(ms).toLocaleString() : "—";
  }
</script>

<header class="page-head">
  <h1>Schedules</h1>
  <p class="page-lead">Cron-driven scheduled agents and their run history.</p>
</header>

<div class="card">
  <div class="card-header">
    <h2>All schedules</h2>
    <span class="stat-detail">{schedules.length} total</span>
  </div>
  {#if schedules.length === 0}
    <p class="empty-state">No schedules.</p>
  {:else}
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Cron / At</th>
          <th>Status</th>
          <th>Next run</th>
          <th>Last run</th>
        </tr>
      </thead>
      <tbody>
        {#each schedules as s}
          <tr>
            <td class="text-mono">{s.name}</td>
            <td>
              {#if s.cron}<code>{s.cron}</code>
              {:else if s.runAt}{s.runAt}
              {:else}—{/if}
            </td>
            <td>
              {#if s.paused}
                <span class="badge warn">paused</span>
              {:else}
                <span class="badge ok">active</span>
              {/if}
            </td>
            <td>{fmtTs(s.nextRunAt)}</td>
            <td>{fmtTs(s.lastRunAt)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .text-mono {
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text-primary);
  }
</style>
