<script lang="ts">
  import type { PageData } from "./$types";

  interface Entry {
    id: string;
    title: string;
    tags: string[];
    recallCount: number;
    updatedAt: string;
  }

  let { data }: { data: PageData } = $props();
  let entries = $derived(data.entries as Entry[]);
</script>

<header class="page-head">
  <h1>Memory</h1>
  <p class="page-lead">Persistent knowledge store. Auto-recalled into agent prompts.</p>
</header>

<div class="card">
  <div class="card-header">
    <h2>All entries</h2>
    <span class="stat-detail">{entries.length} total</span>
  </div>
  {#if entries.length === 0}
    <p class="empty-state">No memories yet.</p>
  {:else}
    <table class="data-table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Tags</th>
          <th>Recalls</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {#each entries as e}
          <tr>
            <td>
              <a href="/memory/{encodeURIComponent(e.id)}" class="link-title">{e.title}</a>
            </td>
            <td class="tags-cell">
              {#each e.tags as tag}
                <span class="tag">#{tag}</span>
              {/each}
            </td>
            <td class="text-mono">{e.recallCount}</td>
            <td class="text-muted">{new Date(e.updatedAt).toLocaleDateString()}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .link-title {
    color: var(--text-primary);
    text-decoration: none;
    font-weight: 500;
  }
  .link-title:hover { color: var(--accent-primary); text-decoration: underline; }
  .tags-cell { display: flex; gap: 0.3rem; flex-wrap: wrap; }
  .tag {
    background: var(--bg-tertiary);
    color: var(--text-tertiary);
    padding: 0.1rem 0.4rem;
    border-radius: 99px;
    font-size: 0.7rem;
    font-family: var(--font-mono);
  }
  .text-mono {
    font-family: var(--font-mono);
    color: var(--text-secondary);
  }
  .text-muted { color: var(--text-tertiary); }
</style>
