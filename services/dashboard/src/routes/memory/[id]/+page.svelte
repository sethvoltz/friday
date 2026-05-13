<script lang="ts">
  import type { PageData } from "./$types";
  import Markdown from "$lib/components/Markdown/Markdown.svelte";
  import { goto, invalidateAll } from "$app/navigation";
  import { confirmDialog } from "$lib/components/ConfirmDialog/store.svelte";

  let { data }: { data: PageData } = $props();

  // svelte-ignore state_referenced_locally
  let entry = $state(data.entry);
  let editing = $state(false);
  let saving = $state(false);
  let title = $state("");
  let tagsText = $state("");
  let content = $state("");
  let toast = $state<{ msg: string; kind: "ok" | "err" | "info" } | null>(null);

  function showToast(msg: string, kind: "ok" | "err" | "info" = "ok") {
    toast = { msg, kind };
    setTimeout(() => {
      toast = null;
    }, 4500);
  }

  function startEdit() {
    title = entry.title;
    tagsText = entry.tags.join(", ");
    content = entry.content;
    editing = true;
  }

  function cancelEdit() {
    editing = false;
  }

  async function save() {
    if (!title.trim() || !content.trim()) {
      showToast("title and content are required", "err");
      return;
    }
    saving = true;
    try {
      const tags = tagsText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const r = await fetch(`/api/memory/${encodeURIComponent(entry.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), content, tags }),
      });
      if (!r.ok) {
        showToast(`save failed (${r.status})`, "err");
        return;
      }
      const fresh = (await r.json()) as typeof entry;
      entry = fresh;
      editing = false;
      showToast("saved");
      await invalidateAll();
    } finally {
      saving = false;
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `Delete memory "${entry.title}"?`,
      description: `Delete memory ${entry.id}? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const r = await fetch(`/api/memory/${encodeURIComponent(entry.id)}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      showToast(`delete failed (${r.status})`, "err");
      return;
    }
    void goto("/memory");
  }
</script>

<header class="page-head">
  <a class="back-link" href="/memory">← All memory</a>
  <h1>{entry.title}</h1>
  <div class="meta">
    {#each entry.tags as tag (tag)}
      <span class="tag">#{tag}</span>
    {/each}
    {#if entry.tags.length > 0}<span class="dot-sep"></span>{/if}
    <span class="stat-detail">{entry.recallCount} recalls</span>
    <span class="dot-sep"></span>
    <span class="stat-detail">by {entry.createdBy}</span>
    <span class="dot-sep"></span>
    <span class="stat-detail"
      >updated {new Date(entry.updatedAt).toLocaleString()}</span>
  </div>
</header>

<div class="card">
  <div class="card-header">
    <h2>{editing ? "Edit" : "Content"}</h2>
    <div class="head-actions">
      {#if editing}
        <button
          type="button"
          class="ghost"
          onclick={cancelEdit}
          disabled={saving}>Cancel</button>
        <button
          type="button"
          class="ghost primary"
          onclick={save}
          disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      {:else}
        <button type="button" class="ghost" onclick={startEdit}>Edit</button>
        <button type="button" class="ghost danger" onclick={remove}>
          Delete
        </button>
      {/if}
    </div>
  </div>

  {#if editing}
    <label class="field">
      <span class="row-label">Title</span>
      <input class="input" bind:value={title} />
    </label>
    <label class="field">
      <span class="row-label">Tags (comma-separated)</span>
      <input class="input" bind:value={tagsText} placeholder="ops, runbook" />
    </label>
    <label class="field">
      <span class="row-label">Content (markdown)</span>
      <textarea class="textarea" rows="20" bind:value={content}></textarea>
    </label>
  {:else}
    <Markdown source={entry.content} />
  {/if}
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
  .meta {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: center;
    margin-top: 0.5rem;
  }
  .tag {
    background: var(--bg-tertiary);
    color: var(--text-tertiary);
    padding: 0.1rem 0.4rem;
    border-radius: 99px;
    font-size: 0.7rem;
    font-family: var(--font-mono);
  }
  .dot-sep {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--text-tertiary);
  }
  .head-actions {
    display: flex;
    gap: 0.4rem;
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
    margin-top: 0.75rem;
  }
  .input,
  .textarea {
    padding: 0.55rem 0.65rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.9rem;
    font-family: inherit;
    width: 100%;
  }
  .textarea {
    font-family: var(--font-mono);
    resize: vertical;
    min-height: 320px;
  }
  button.primary {
    color: var(--accent-primary);
    border-color: var(--accent-primary);
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
