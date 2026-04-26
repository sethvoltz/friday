<script lang="ts">
  import type { MemoryEntry } from "@friday/memory";
  import Markdown from "$lib/Markdown.svelte";

  let { data } = $props();
  const entry: MemoryEntry = $derived(data.entry);

  function fmtDate(d: string): string {
    return new Date(d).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function fmtAge(d: string): string {
    const ms = Date.now() - new Date(d).getTime();
    const mins = Math.floor(ms / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }
</script>

<div class="memory-detail">
  <header class="detail-header">
    <h2>{entry.title}</h2>
    <div class="meta-row">
      <span>Created by <strong>{entry.createdBy}</strong></span>
      <span class="sep">&middot;</span>
      <span>{fmtDate(entry.createdAt)}</span>
      <span class="sep">&middot;</span>
      <span>Recalled {entry.recallCount}x</span>
      {#if entry.lastRecalledAt}
        <span class="sep">&middot;</span>
        <span>Last recalled {fmtAge(entry.lastRecalledAt)}</span>
      {/if}
    </div>
    {#if entry.tags.length > 0}
      <div class="tags">
        {#each entry.tags as tag}
          <span class="tag">{tag}</span>
        {/each}
      </div>
    {/if}
  </header>

  <div class="detail-body">
    <div class="memory-content"><Markdown source={entry.content} /></div>
  </div>
</div>

<style>
  .memory-detail {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .detail-header {
    padding: 1rem 0 1rem;
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .detail-header h2 {
    margin: 0 0 0.5rem;
    font-size: 1.2rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .meta-row {
    font-size: 0.8rem;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .sep {
    color: var(--text-tertiary);
  }

  .tags {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.6rem;
    flex-wrap: wrap;
  }

  .tag {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    font-size: 0.7rem;
    font-weight: 500;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border-radius: 99px;
  }

  .detail-body {
    flex: 1;
    overflow-y: auto;
    padding: 1.25rem 0;
  }

  .memory-content {
    margin: 0;
    max-width: 65ch;
  }
</style>
