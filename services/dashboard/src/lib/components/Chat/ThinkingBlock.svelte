<script lang="ts">
  import { Brain } from "lucide-svelte";

  interface Props {
    text: string;
    status: "running" | "done" | "aborted";
    isRedacted?: boolean;
  }
  let { text, status, isRedacted = false }: Props = $props();

  let open = $state(false);
  let hasText = $derived(text.length > 0);
</script>

<div class="thinking-block">
  <button
    type="button"
    class="thinking-head"
    onclick={() => (open = !open)}
    aria-expanded={open}>
    <span class="thinking-icon" aria-hidden="true"><Brain size={16} /></span>
    <span class="label">
      Thinking{status === "running" ? "…" : ""}
    </span>
    {#if status === "running"}<span class="dots">●●●</span>{/if}
    {#if status === "aborted"}<span class="aborted-tag">stopped</span>{/if}
    <span class="expand-toggle" aria-hidden="true">{open ? "−" : "+"}</span>
  </button>
  {#if isRedacted}
    <span class="redacted-badge">Redacted by Anthropic</span>
  {/if}
  {#if open && hasText}
    <pre class="thinking-body">{text}</pre>
  {/if}
</div>

<style>
  .thinking-block {
    border-left: 2px solid var(--border-primary);
    padding: 0.25rem 0;
    color: var(--text-tertiary);
    font-size: 0.85rem;
  }
  .thinking-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.25rem 0.75rem;
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    user-select: none;
  }
  .thinking-icon {
    display: inline-flex;
    align-items: center;
    color: var(--text-tertiary);
  }
  .label {
    font-style: italic;
  }
  .dots {
    color: var(--accent-primary);
    font-size: 0.55rem;
    letter-spacing: 0.1em;
    animation: pulse 1.4s ease-in-out infinite;
  }
  .aborted-tag {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    font-weight: 600;
    font-style: normal;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 1; }
  }
  .expand-toggle {
    margin-left: auto;
    width: 1.4rem;
    height: 1.4rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 1rem;
    line-height: 1;
    border-radius: var(--radius-sm);
  }
  .thinking-head:hover .expand-toggle {
    background: var(--bg-card);
    color: var(--text-secondary);
  }
  .thinking-body {
    margin: 0.4rem 0.75rem 0.25rem 1.25rem;
    padding: 0.5rem 0.75rem;
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--text-tertiary);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
    max-height: 280px;
    overflow-y: auto;
    font-style: italic;
  }
  .redacted-badge {
    display: inline-block;
    margin: 0 0.75rem 0.25rem 0.75rem;
    padding: 0.1rem 0.5rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    font-style: normal;
  }
</style>
