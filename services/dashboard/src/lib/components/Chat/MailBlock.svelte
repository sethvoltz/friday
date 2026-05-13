<script lang="ts">
  import { Mail } from "lucide-svelte";

  interface MailMeta {
    id: number;
    subject: string | null;
    type: string;
    priority: string;
    threadId: string | null;
    ts: number;
  }
  interface Props {
    fromAgent: string;
    body: string;
    meta?: MailMeta;
  }
  let { fromAgent, body, meta }: Props = $props();

  let open = $state(false);
  let hasBody = $derived(body.length > 0);

  function fmtTs(ts: number): string {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }
</script>

<div class="mail-block">
  <button
    type="button"
    class="mail-head"
    onclick={() => hasBody && (open = !open)}
    aria-expanded={hasBody ? open : undefined}
    disabled={!hasBody}>
    <span class="mail-icon" aria-hidden="true"><Mail size={16} /></span>
    <span class="mail-label">Mail received from</span>
    <code class="mail-from">{fromAgent}</code>
    {#if hasBody}
      <span class="expand-toggle" aria-hidden="true">{open ? "−" : "+"}</span>
    {/if}
  </button>
  {#if open && hasBody}
    <div class="mail-body">
      {#if meta}
        <dl class="mail-meta">
          <dt>id</dt>
          <dd><code>{meta.id}</code></dd>
          {#if meta.subject}
            <dt>subject</dt>
            <dd>{meta.subject}</dd>
          {/if}
          <dt>type</dt>
          <dd><code>{meta.type}</code></dd>
          {#if meta.priority && meta.priority !== "normal"}
            <dt>priority</dt>
            <dd><code class="priority-{meta.priority}">{meta.priority}</code></dd>
          {/if}
          {#if meta.threadId}
            <dt>thread</dt>
            <dd><code>{meta.threadId}</code></dd>
          {/if}
          {#if meta.ts}
            <dt>sent</dt>
            <dd>{fmtTs(meta.ts)}</dd>
          {/if}
        </dl>
      {/if}
      <div class="mail-body-label">body</div>
      <pre class="mail-pre">{body}</pre>
    </div>
  {/if}
</div>

<style>
  .mail-block {
    border-left: 2px solid var(--accent-primary);
    padding: 0.25rem 0;
    font-size: 0.85rem;
  }
  .mail-head {
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
  .mail-head:disabled {
    cursor: default;
  }
  .mail-icon {
    display: inline-flex;
    align-items: center;
    color: var(--accent-primary);
  }
  .mail-label {
    color: var(--text-secondary);
  }
  .mail-from {
    color: var(--accent-primary);
    font-family: var(--font-mono);
    font-size: 0.85rem;
    background: transparent;
    border: none;
    padding: 0;
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
  .mail-head:hover .expand-toggle {
    background: var(--bg-card);
    color: var(--text-secondary);
  }
  .mail-body {
    margin: 0.4rem 0.75rem 0.25rem 1.25rem;
    padding: 0.5rem 0.75rem;
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
  }
  .mail-meta {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.2rem 0.75rem;
    margin: 0 0 0.6rem 0;
    font-size: 0.78rem;
  }
  .mail-meta dt {
    color: var(--text-tertiary);
    text-transform: uppercase;
    font-size: 0.65rem;
    letter-spacing: 0.06em;
    align-self: center;
  }
  .mail-meta dd {
    margin: 0;
    color: var(--text-primary);
    overflow-wrap: anywhere;
  }
  .mail-meta code {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    background: var(--bg-code);
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    color: var(--text-secondary);
  }
  .priority-critical {
    color: var(--status-error);
  }
  .mail-body-label {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
  .mail-pre {
    margin: 0;
    padding: 0.5rem 0.6rem;
    background: var(--bg-code);
    border-radius: var(--radius-sm);
    overflow-x: auto;
    max-height: 400px;
    overflow-y: auto;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
  }
</style>
