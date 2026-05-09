<script lang="ts">
  import type { PageData } from "./$types";
  import Markdown from "$lib/components/Markdown/Markdown.svelte";

  let { data }: { data: PageData } = $props();
  let e = $derived(
    data.entry as {
      title: string;
      content: string;
      tags: string[];
      recallCount: number;
      createdBy: string;
      updatedAt: string;
    },
  );
</script>

<header class="page-head">
  <a class="back-link" href="/memory">← All memory</a>
  <h1>{e.title}</h1>
  <div class="meta">
    {#each e.tags as tag}
      <span class="tag">#{tag}</span>
    {/each}
    <span class="dot-sep"></span>
    <span class="stat-detail">{e.recallCount} recalls</span>
    <span class="dot-sep"></span>
    <span class="stat-detail">by {e.createdBy}</span>
    <span class="dot-sep"></span>
    <span class="stat-detail">updated {new Date(e.updatedAt).toLocaleDateString()}</span>
  </div>
</header>

<div class="card">
  <Markdown source={e.content} />
</div>

<style>
  .back-link { font-size: 0.85rem; color: var(--text-tertiary); text-decoration: none; }
  .back-link:hover { color: var(--accent-primary); }
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
</style>
