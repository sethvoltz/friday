<script lang="ts">
  import type { PageData } from "./$types";
  import Markdown from "$lib/components/Markdown/Markdown.svelte";
  import { invalidateAll } from "$app/navigation";
  import type { TicketStatus } from "@friday/shared/services";

  let { data }: { data: PageData } = $props();

  // Track the server-loaded ticket directly. Every mutation handler calls
  // `invalidateAll()` after a successful PATCH/POST/DELETE; SvelteKit
  // re-runs the load function, `data.ticket` updates, and this derived
  // ref follows. The previous version mirrored `data.ticket` into a
  // local $state and shallow-cloned on each mutation, which left stale
  // comment/external-link arrays whenever two mutations interleaved.
  const t = $derived(data.ticket);
  let savingStatus = $state(false);
  let savingAssignee = $state(false);
  // svelte-ignore state_referenced_locally
  let assigneeInput = $state(data.ticket.assignee ?? "");
  let commentBody = $state("");
  let postingComment = $state(false);
  let toast = $state<{ msg: string; kind: "ok" | "err" | "info" } | null>(null);

  // External-link form
  let linkSystem = $state("");
  let linkExternalId = $state("");
  let linkUrl = $state("");
  let linking = $state(false);

  const STATUSES: TicketStatus[] = [
    "open",
    "in_progress",
    "blocked",
    "done",
    "closed",
  ];

  // FIX_FORWARD 6.7: a tiny transition matrix. The daemon doesn't enforce
  // it (any status patch is accepted) but the UI nudges the user away
  // from nonsensical jumps (e.g. closed → in_progress) by greying them
  // out. "open" is always reachable as a reset.
  const TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
    open: ["in_progress", "blocked", "done", "closed"],
    in_progress: ["open", "blocked", "done", "closed"],
    blocked: ["open", "in_progress", "closed"],
    done: ["open", "closed"],
    closed: ["open"],
  };

  function canTransition(to: TicketStatus): boolean {
    if (to === t.status) return true;
    return TRANSITIONS[t.status as TicketStatus].includes(to);
  }

  function showToast(msg: string, kind: "ok" | "err" | "info" = "ok") {
    toast = { msg, kind };
    setTimeout(() => {
      toast = null;
    }, 4500);
  }

  function badgeClass(status: string): string {
    if (status === "done" || status === "closed") return "ok";
    if (status === "in_progress") return "ok";
    if (status === "blocked") return "error";
    return "warn";
  }

  async function setStatus(status: TicketStatus) {
    if (status === t.status || !canTransition(status)) return;
    savingStatus = true;
    try {
      const r = await fetch(`/api/tickets/${t.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) {
        showToast(`status update failed (${r.status})`, "err");
        return;
      }
      await invalidateAll();
      showToast(`status → ${status}`);
    } finally {
      savingStatus = false;
    }
  }

  async function setAssignee() {
    const next = assigneeInput.trim() || null;
    if (next === t.assignee) return;
    savingAssignee = true;
    try {
      const r = await fetch(`/api/tickets/${t.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignee: next }),
      });
      if (!r.ok) {
        showToast(`assignee update failed (${r.status})`, "err");
        return;
      }
      await invalidateAll();
      showToast(next ? `assigned → ${next}` : "unassigned");
    } finally {
      savingAssignee = false;
    }
  }

  async function postComment(e: Event) {
    e.preventDefault();
    if (!commentBody.trim()) return;
    postingComment = true;
    try {
      const r = await fetch(`/api/tickets/${t.id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          author: data.defaultAuthor,
          body: commentBody,
        }),
      });
      if (!r.ok) {
        showToast(`comment failed (${r.status})`, "err");
        return;
      }
      commentBody = "";
      await invalidateAll();
      showToast("comment posted");
    } finally {
      postingComment = false;
    }
  }

  async function addLink(e: Event) {
    e.preventDefault();
    if (!linkSystem.trim() || !linkExternalId.trim()) return;
    linking = true;
    try {
      const r = await fetch(`/api/tickets/${t.id}/links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system: linkSystem.trim(),
          externalId: linkExternalId.trim(),
          url: linkUrl.trim() || undefined,
        }),
      });
      if (!r.ok) {
        showToast(`link failed (${r.status})`, "err");
        return;
      }
      linkSystem = "";
      linkExternalId = "";
      linkUrl = "";
      await invalidateAll();
      showToast("link added");
    } finally {
      linking = false;
    }
  }

  async function removeLink(system: string, externalId: string) {
    if (!confirm(`Detach link ${system}:${externalId}?`)) return;
    const qs = `?system=${encodeURIComponent(system)}&externalId=${encodeURIComponent(externalId)}`;
    const r = await fetch(`/api/tickets/${t.id}/links${qs}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      showToast(`detach failed (${r.status})`, "err");
      return;
    }
    await invalidateAll();
    showToast("link removed");
  }
</script>

<header class="page-head">
  <a class="back-link" href="/tickets">← All tickets</a>
  <h1><span class="ticket-id">{t.id}</span> {t.title}</h1>
  <div class="meta">
    <span class="badge {badgeClass(t.status)}">{t.status}</span>
    <span class="kind">{t.kind}</span>
    {#if t.assignee}<span class="assignee">→ {t.assignee}</span>{/if}
  </div>
</header>

<div class="grid">
  <div class="card">
    <div class="card-header"><h2>Status</h2></div>
    <label class="field">
      <span class="row-label">Status</span>
      <select
        class="input"
        value={t.status}
        onchange={(e) =>
          setStatus(
            (e.currentTarget as HTMLSelectElement).value as TicketStatus,
          )}
        disabled={savingStatus}>
        {#each STATUSES as s (s)}
          <option value={s} disabled={!canTransition(s)}>
            {s}{canTransition(s) ? "" : " (not allowed)"}
          </option>
        {/each}
      </select>
      <span class="field-hint">
        From <code>{t.status}</code> you can transition to:
        {TRANSITIONS[t.status as TicketStatus].join(", ") || "(none)"}.
      </span>
    </label>
  </div>

  <div class="card">
    <div class="card-header"><h2>Assignee</h2></div>
    <div class="assignee-row">
      <input
        class="input"
        bind:value={assigneeInput}
        placeholder="user, friday, builder-XYZ…"
        disabled={savingAssignee} />
      <button
        type="button"
        class="ghost primary"
        onclick={setAssignee}
        disabled={savingAssignee || assigneeInput.trim() === (t.assignee ?? "")}>
        {savingAssignee ? "Saving…" : "Save"}
      </button>
      {#if t.assignee}
        <button
          type="button"
          class="ghost"
          onclick={() => {
            assigneeInput = "";
            void setAssignee();
          }}
          disabled={savingAssignee}>
          Unassign
        </button>
      {/if}
    </div>
  </div>

  <div class="card wide">
    <div class="card-header">
      <h2>External links</h2>
      <span class="stat-detail">{t.externalLinks.length}</span>
    </div>
    {#if t.externalLinks.length === 0}
      <p class="empty-state">No external links yet.</p>
    {:else}
      <ul class="link-list">
        {#each t.externalLinks as l (l.system + ":" + l.externalId)}
          <li>
            <span class="link-system">{l.system}</span>
            <code class="text-mono">{l.externalId}</code>
            {#if l.url}
              <a
                href={l.url}
                target="_blank"
                rel="noopener"
                class="link-url">↗ open</a>
            {/if}
            <button
              type="button"
              class="ghost compact danger"
              onclick={() => removeLink(l.system, l.externalId)}>
              Remove
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <form class="link-form" onsubmit={addLink}>
      <div class="link-form-row">
        <label class="field">
          <span class="row-label">System</span>
          <input
            class="input"
            bind:value={linkSystem}
            placeholder="linear, github, …"
            required />
        </label>
        <label class="field">
          <span class="row-label">External ID</span>
          <input
            class="input"
            bind:value={linkExternalId}
            placeholder="FRI-123, #42, …"
            required />
        </label>
        <label class="field">
          <span class="row-label">URL (optional)</span>
          <input
            class="input"
            bind:value={linkUrl}
            placeholder="https://…" />
        </label>
      </div>
      <div class="actions">
        <button
          type="submit"
          class="ghost primary"
          disabled={linking || !linkSystem.trim() || !linkExternalId.trim()}>
          {linking ? "Adding…" : "Add link"}
        </button>
      </div>
    </form>
  </div>

  {#if t.body}
    <div class="card wide">
      <div class="card-header"><h2>Body</h2></div>
      <Markdown source={t.body} />
    </div>
  {/if}

  <div class="card wide">
    <div class="card-header">
      <h2>Comments</h2>
      <span class="stat-detail">{t.comments.length}</span>
    </div>
    {#if t.comments.length === 0}
      <p class="empty-state">No comments yet.</p>
    {:else}
      <ul class="comment-list">
        {#each t.comments as c (c.id)}
          <li class="comment">
            <div class="comment-head">
              <span class="comment-author">{c.author}</span>
              <span class="comment-time">{new Date(c.ts).toLocaleString()}</span>
            </div>
            <div class="comment-body">
              <Markdown source={c.body} />
            </div>
          </li>
        {/each}
      </ul>
    {/if}
    <form class="comment-form" onsubmit={postComment}>
      <label class="field">
        <span class="row-label">Add comment (as {data.defaultAuthor})</span>
        <textarea
          class="textarea"
          rows="4"
          bind:value={commentBody}
          placeholder="Markdown supported."
          disabled={postingComment}></textarea>
      </label>
      <div class="actions">
        <button
          type="submit"
          class="ghost primary"
          disabled={postingComment || !commentBody.trim()}>
          {postingComment ? "Posting…" : "Post comment"}
        </button>
      </div>
    </form>
  </div>
</div>

{#if toast}
  <div class="toast toast-{toast.kind}" role="status" aria-live="polite">
    {toast.msg}
  </div>
{/if}

<style>
  .back-link {
    font-size: 0.85rem;
    color: var(--text-tertiary);
    text-decoration: none;
  }
  .back-link:hover {
    color: var(--accent-primary);
  }
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
  .row-label {
    color: var(--text-tertiary);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    flex: 1;
    min-width: 0;
  }
  .field-hint {
    color: var(--text-tertiary);
    font-size: 0.7rem;
  }
  .input,
  .textarea {
    width: 100%;
    padding: 0.5rem 0.6rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.9rem;
    font-family: inherit;
  }
  .textarea {
    font-family: var(--font-mono);
    resize: vertical;
  }
  .assignee-row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .assignee-row .input {
    flex: 1;
    min-width: 180px;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.6rem;
  }
  button.primary {
    color: var(--accent-primary);
    border-color: var(--accent-primary);
  }
  button.compact {
    padding: 0.25rem 0.55rem;
    font-size: 0.75rem;
  }
  .wide {
    grid-column: 1 / -1;
  }
  .link-list {
    list-style: none;
    padding: 0;
    margin: 0 0 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .link-list li {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.7rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
  }
  .link-system {
    text-transform: uppercase;
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    font-weight: 600;
    color: var(--text-tertiary);
    min-width: 5rem;
  }
  .link-url {
    color: var(--accent-primary);
    text-decoration: none;
    font-size: 0.8rem;
  }
  .link-url:hover {
    text-decoration: underline;
  }
  .link-form {
    border-top: 1px solid var(--border-subtle);
    padding-top: 0.75rem;
  }
  .link-form-row {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .text-mono {
    font-family: var(--font-mono);
    font-size: 0.8rem;
  }
  .comment-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .comment {
    border-left: 2px solid var(--border-subtle);
    padding: 0.4rem 0 0.4rem 0.9rem;
  }
  .comment-head {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    font-size: 0.75rem;
    color: var(--text-tertiary);
    margin-bottom: 0.3rem;
  }
  .comment-author {
    font-weight: 600;
    color: var(--text-secondary);
  }
  .comment-form {
    margin-top: 0.75rem;
    border-top: 1px solid var(--border-subtle);
    padding-top: 0.75rem;
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
