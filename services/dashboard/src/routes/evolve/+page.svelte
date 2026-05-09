<script lang="ts">
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  let proposals = $derived(
    data.proposals as Array<{
      id: string;
      title: string;
      status: string;
      score: number;
    }>,
  );

  function badgeClass(status: string): string {
    if (status === "applied") return "ok";
    if (status === "approved") return "ok";
    if (status === "critical") return "error";
    if (status === "rejected") return "warn";
    return "";
  }
</script>

<header class="page-head">
  <h1>Evolve</h1>
  <p class="page-lead">Self-improvement proposals (scan → enrich → cluster → apply).</p>
</header>

<div class="card">
  <div class="card-header">
    <h2>Proposals</h2>
    <span class="stat-detail">{proposals.length} total</span>
  </div>
  {#if proposals.length === 0}
    <p class="empty-state">
      No proposals yet. Friday's daily meta-agent runs at 04:00 and scans the daemon log,
      usage table, and transcripts for patterns worth improving. You can also trigger a scan
      on demand from the orchestrator chat with <code>evolve_scan</code>, or capture a
      proposal manually via <code>evolve_save</code>.
    </p>
  {:else}
    <table class="data-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Title</th>
          <th>Status</th>
          <th>Score</th>
        </tr>
      </thead>
      <tbody>
        {#each proposals as p}
          <tr>
            <td class="text-mono">{p.id}</td>
            <td>{p.title}</td>
            <td><span class="badge {badgeClass(p.status)}">{p.status}</span></td>
            <td class="text-mono">{p.score}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .text-mono {
    font-family: var(--font-mono);
    font-size: 0.8rem;
    color: var(--text-secondary);
  }
</style>
