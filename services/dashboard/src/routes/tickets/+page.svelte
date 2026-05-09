<script lang="ts">
  import type { PageData } from "./$types";

  interface Ticket {
    id: string;
    title: string;
    status: string;
    kind: string;
    assignee: string | null;
    updatedAt: number;
  }

  let { data }: { data: PageData } = $props();
  let tickets = $state<Ticket[]>([]);
  $effect(() => {
    tickets = data.tickets as Ticket[];
  });
  let creating = $state(false);
  let newTitle = $state("");

  async function createNew(e: Event) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    creating = true;
    try {
      const r = await fetch("/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: newTitle, kind: "task" }),
      });
      if (r.ok) {
        const t = (await r.json()) as Ticket;
        tickets = [t, ...tickets];
        newTitle = "";
      }
    } finally {
      creating = false;
    }
  }

  function badgeClass(status: string): string {
    if (status === "done" || status === "closed") return "ok";
    if (status === "in_progress") return "ok";
    if (status === "blocked") return "error";
    return "warn";
  }
</script>

<header class="page-head">
  <h1>Tickets</h1>
  <p class="page-lead">Internal coordination + external system links.</p>
</header>

<div class="card">
  <form class="newform" onsubmit={createNew}>
    <input
      class="page-input"
      bind:value={newTitle}
      placeholder="New ticket title…" />
    <button type="submit" class="primary" disabled={creating || !newTitle.trim()}>
      Create
    </button>
  </form>
</div>

<div class="card">
  <div class="card-header">
    <h2>All tickets</h2>
    <span class="stat-detail">{tickets.length} total</span>
  </div>
  {#if tickets.length === 0}
    <p class="empty-state">
      No tickets yet. Create one above or via <code>friday tickets create</code>.
    </p>
  {:else}
    <table class="data-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Title</th>
          <th>Kind</th>
          <th>Status</th>
          <th>Assignee</th>
        </tr>
      </thead>
      <tbody>
        {#each tickets as t}
          <tr>
            <td><a href="/tickets/{t.id}" class="link-mono">{t.id}</a></td>
            <td><a href="/tickets/{t.id}" class="link-title">{t.title}</a></td>
            <td>{t.kind}</td>
            <td><span class="badge {badgeClass(t.status)}">{t.status}</span></td>
            <td>{t.assignee ?? "—"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .newform {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .newform input {
    flex: 1;
  }
  .link-mono {
    color: var(--accent-primary);
    font-family: var(--font-mono);
    text-decoration: none;
  }
  .link-title {
    color: var(--text-primary);
    text-decoration: none;
    font-weight: 500;
  }
  .link-mono:hover, .link-title:hover { text-decoration: underline; }
</style>
