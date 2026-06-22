<script lang="ts">
  // FRI-172 — one memory rendered as a collapsed summary that expands inline
  // into an accordion (Markdown body + Edit/Delete). The parent (MemoryPage)
  // owns `openId` + shallow routing, so this card communicates open/save/delete
  // upward via callback props and never calls `goto`/`pushState`/a mutator
  // itself. Edit swaps the body for the shared `MemoryEditor` (AC15).
  import Markdown from "$lib/components/Markdown/Markdown.svelte";
  import MemoryEditor from "./MemoryEditor.svelte";
  import type { MemoryView } from "./facet-filter";

  interface Props {
    entry: MemoryView;
    /** Whether this card's accordion is expanded. */
    open: boolean;
    /** Toggle open/closed (parent owns openId + shallow routing). */
    ontoggle?: (id: string) => void;
    /** Save an inline edit (parent runs the mutator). */
    onsave?: (
      id: string,
      data: { title: string; content: string; tags: string[] },
    ) => void;
    /** Request delete (parent runs confirmDialog + mutator + collapse). */
    ondelete?: (id: string) => void;
  }

  let { entry, open, ontoggle, onsave, ondelete }: Props = $props();

  // Local edit-mode toggle. Collapsing the card resets it so a reopened card
  // starts in read mode.
  let editing = $state(false);
  $effect(() => {
    if (!open) editing = false;
  });

  // Reveal-to-open (AC11): the card scrolls itself into view when it mounts
  // while already open (cold deep-link / sort-beyond-50 reveal) and whenever it
  // transitions to open.
  let cardEl = $state<HTMLElement | undefined>();
  $effect(() => {
    if (open && cardEl) {
      cardEl.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  });

  // Collapsed snippet — first ~220 chars of the body, same budget as the
  // current list page.
  const previewText = $derived(entry.content.slice(0, 220));

  function handleSave(data: {
    title: string;
    content: string;
    tags: string[];
  }) {
    onsave?.(entry.id, data);
    editing = false;
  }
</script>

<li class="memory-card" class:open bind:this={cardEl}>
  <div class="card-summary">
    <button
      type="button"
      class="card-title"
      aria-expanded={open}
      onclick={() => ontoggle?.(entry.id)}>
      <span class="glyph" aria-hidden="true">{open ? "−" : "+"}</span>
      <span class="title-text">{entry.title}</span>
    </button>
    {#if entry.tags.length > 0}
      <div class="card-tags">
        {#each entry.tags as tag (tag)}
          <span class="tag">#{tag}</span>
        {/each}
      </div>
    {/if}
    {#if !open}
      <p class="card-snippet">{previewText}</p>
    {/if}
    <div class="card-meta">
      <span>{entry.recallCount} recalls</span>
      <span class="dot-sep"></span>
      <span>by {entry.createdBy}</span>
      <span class="dot-sep"></span>
      <span>updated {new Date(entry.updatedAt).toLocaleString()}</span>
    </div>
  </div>

  {#if open}
    <div class="card-body">
      {#if editing}
        <MemoryEditor
          mode="edit"
          entry={entry}
          onsave={handleSave}
          oncancel={() => (editing = false)} />
      {:else}
        <div class="markdown-wrap">
          <Markdown source={entry.content} />
        </div>
        <div class="body-actions">
          <button type="button" class="ghost" onclick={() => (editing = true)}>
            Edit
          </button>
          <button
            type="button"
            class="ghost danger"
            onclick={() => ondelete?.(entry.id)}>
            Delete
          </button>
        </div>
      {/if}
    </div>
  {/if}
</li>

<style>
  .memory-card {
    list-style: none;
    padding: 0.6rem 0.75rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    transition: border-color var(--transition-fast);
  }
  .memory-card.open {
    border-color: var(--border-primary);
    background: var(--bg-card);
  }
  .card-summary {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .card-title {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    text-align: left;
    cursor: pointer;
    color: var(--text-primary);
    font-weight: 600;
    font-size: 0.95rem;
    font-family: inherit;
    width: 100%;
    /* Keyboard / pointer target (AC21/AC22). */
    min-height: 44px;
  }
  .card-title:hover .title-text {
    color: var(--accent-primary);
  }
  .card-title:focus-visible {
    outline: none;
  }
  .card-title:focus-visible .title-text {
    color: var(--accent-primary);
    text-decoration: underline;
  }
  .glyph {
    font-family: var(--font-mono);
    font-size: 1rem;
    line-height: 1;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }
  .title-text {
    min-width: 0;
    word-break: break-word;
  }
  .card-tags {
    display: flex;
    gap: 0.25rem;
    flex-wrap: wrap;
  }
  .tag {
    background: var(--bg-tertiary);
    color: var(--text-tertiary);
    padding: 0.1rem 0.4rem;
    border-radius: 99px;
    font-size: 0.68rem;
    font-family: var(--font-mono);
  }
  .card-snippet {
    margin: 0.1rem 0 0;
    font-size: 0.82rem;
    color: var(--text-secondary);
    line-height: 1.4;
    word-break: break-word;
    max-height: 4.5em;
    overflow: hidden;
  }
  .card-meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    font-size: 0.72rem;
    color: var(--text-tertiary);
  }
  .dot-sep {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--text-tertiary);
  }
  .card-body {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border-subtle);
  }
  .markdown-wrap {
    font-size: 0.9rem;
  }
  .body-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
</style>
