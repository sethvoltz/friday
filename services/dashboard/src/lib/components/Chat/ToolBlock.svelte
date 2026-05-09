<script lang="ts">
  interface Props {
    toolName: string;
    status: "running" | "done" | "error";
    input?: unknown;
    output?: string;
  }
  let { toolName, status, input, output }: Props = $props();

  let open = $state(false);

  function fmtInput(v: unknown): string {
    if (v === undefined || v === null) return "";
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  let inputText = $derived(fmtInput(input));
  let hasInput = $derived(inputText.length > 0 && inputText !== "{}");
  let hasOutput = $derived(typeof output === "string" && output.length > 0);
  let canExpand = $derived(hasInput || hasOutput);

  function badgeClass(s: string): string {
    if (s === "done") return "ok";
    if (s === "error") return "error";
    return "warn"; // running
  }
  function statusLabel(s: string): string {
    if (s === "running") return "running…";
    if (s === "done") return "done";
    return s;
  }
</script>

<div class="tool-block">
  <button
    type="button"
    class="tool-head"
    onclick={() => canExpand && (open = !open)}
    aria-expanded={canExpand ? open : undefined}
    disabled={!canExpand}>
    <span class="tool-icon">⚙</span>
    <code class="tool-name">{toolName}</code>
    <span class="badge {badgeClass(status)}">{statusLabel(status)}</span>
    {#if canExpand}
      <span class="caret">{open ? "▾" : "▸"}</span>
    {/if}
  </button>
  {#if open && hasInput}
    <div class="block-section">
      <div class="block-label">Input</div>
      <pre class="block-pre"><code>{inputText}</code></pre>
    </div>
  {/if}
  {#if open && hasOutput}
    <div class="block-section">
      <div class="block-label">Output</div>
      <pre class="block-pre"><code>{output}</code></pre>
    </div>
  {/if}
</div>

<style>
  .tool-block {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    overflow: hidden;
    font-size: 0.85rem;
  }
  .tool-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    user-select: none;
  }
  .tool-head:disabled {
    cursor: default;
  }
  .tool-icon {
    color: var(--text-tertiary);
  }
  .tool-name {
    color: var(--accent-primary);
    font-family: var(--font-mono);
    font-size: 0.85rem;
    background: transparent;
    border: none;
    padding: 0;
  }
  .caret {
    margin-left: auto;
    color: var(--text-tertiary);
    font-size: 0.7rem;
  }
  .block-section {
    border-top: 1px solid var(--border-subtle);
    padding: 0.5rem 0.75rem;
  }
  .block-label {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
  .block-pre {
    margin: 0;
    padding: 0.5rem 0.6rem;
    background: var(--bg-code);
    border-radius: var(--radius-sm);
    overflow-x: auto;
    max-height: 300px;
    overflow-y: auto;
  }
  .block-pre code {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--text-secondary);
    background: transparent;
    border: none;
    padding: 0;
    white-space: pre;
  }
</style>
