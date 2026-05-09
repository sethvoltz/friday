<script lang="ts">
  import type { PageData } from "./$types";
  import Markdown from "$lib/components/Markdown/Markdown.svelte";

  interface Comment { id: number; author: string; body: string; ts: number }
  interface ExternalLink { system: string; externalId: string; url: string | null }
  interface TicketDetail {
    id: string;
    title: string;
    body: string | null;
    status: string;
    kind: string;
    assignee: string | null;
    createdAt: number;
    updatedAt: number;
    externalLinks: ExternalLink[];
    comments: Comment[];
  }

  let { data }: { data: PageData } = $props();
  let t = $state<TicketDetail | null>(null);
  $effect(() => {
    t = data.ticket as TicketDetail;
  });

  async function setStatus(status: string) {
    if (!t) return;
    const r = await fetch(`/api/tickets/${t.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (r.ok && t) t.status = status;
  }

  function badgeClass(status: string): string {
    if (status === "done" || status === "closed") return "ok";
    if (status === "in_progress") return "ok";
    if (status === "blocked") return "error";
    return "warn";
  }
</script>

{#if t}
  <header class="page-head">
    <a class="back-link" href="/tickets">← All tickets</a>
    <h1><span class="ticket-id">{t.id}</span> {t.title}</h1>
    <div class="meta">
      <span class="badge {badgeClass(t.status)}">{t.status}</span>
      <span class="kind">{t.kind}</span>
      {#if t.assignee}<span class="assignee">→ {t.assignee}</span>{/if}
      {#each t.externalLinks as l}
        {#if l.url}
          <a href={l.url} target="_blank" rel="noopener" class="ext-link">
            {l.system}: {l.externalId} ↗
          </a>
        {:else}
          <span class="ext-link">{l.system}: {l.externalId}</span>
        {/if}
      {/each}
    </div>
  </header>

  <div class="card">
    <div class="card-header">
      <h2>Status</h2>
    </div>
    <div class="status-actions">
      {#each ["open", "in_progress", "done", "blocked", "closed"] as s}
        <button
          class="ghost"
          class:active={t.status === s}
          onclick={() => setStatus(s)}>{s}</button>
      {/each}
    </div>
  </div>

  {#if t.body}
    <div class="card">
      <div class="card-header"><h2>Body</h2></div>
      <Markdown source={t.body} />
    </div>
  {/if}

  <div class="card">
    <div class="card-header">
      <h2>Comments</h2>
      <span class="stat-detail">{t.comments.length}</span>
    </div>
    {#if t.comments.length === 0}
      <p class="empty-state">No comments.</p>
    {:else}
      {#each t.comments as c}
        <div class="comment">
          <div class="chead">{c.author} &middot; {new Date(c.ts).toLocaleString()}</div>
          <Markdown source={c.body} />
        </div>
      {/each}
    {/if}
  </div>
{/if}

<style>
  .back-link { font-size: 0.85rem; color: var(--text-tertiary); text-decoration: none; }
  .back-link:hover { color: var(--accent-primary); }
  .ticket-id {
    color: var(--accent-primary);
    font-family: var(--font-mono);
    margin-right: 0.5rem;
  }
  .meta {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 0.6rem;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
  .kind {
    padding: 0.15rem 0.5rem;
    border-radius: 99px;
    background: var(--bg-tertiary);
    color: var(--text-tertiary);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .ext-link {
    color: var(--accent-primary);
    text-decoration: none;
  }
  .ext-link:hover { text-decoration: underline; }
  .status-actions {
    display: flex; gap: 0.4rem; flex-wrap: wrap;
  }
  .status-actions .active {
    background: var(--accent-primary);
    color: var(--text-inverse);
    border-color: var(--accent-primary);
  }
  .comment {
    border-left: 2px solid var(--border-subtle);
    padding: 0.5rem 0 0.5rem 1rem;
    margin: 0.75rem 0;
  }
  .chead {
    color: var(--text-tertiary);
    font-size: 0.78rem;
    margin-bottom: 0.25rem;
  }
</style>
