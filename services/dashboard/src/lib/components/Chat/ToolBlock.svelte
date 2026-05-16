<script lang="ts">
  import { Wrench } from "lucide-svelte";
  import { page } from "$app/stores";
  import { synthesizeHeadline } from "./tool-headlines";

  interface Props {
    toolName: string;
    status: "running" | "done" | "error" | "aborted";
    input?: unknown;
    output?: string;
    /** FRI-84: mid-stream `input_json_delta` accumulator. Rendered as a
     *  best-effort preview during streaming when `input` is not yet
     *  parsed. Pretty-print if parseable; fall back to raw otherwise. */
    inputPartialJson?: string;
  }
  let { toolName, status, input, output, inputPartialJson }: Props = $props();

  function fmtInput(v: unknown): string {
    if (v === undefined || v === null) return "";
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  let homeDir = $derived(
    (($page.data as { homeDir?: string | null } | undefined)?.homeDir) ?? null,
  );
  let description = $derived.by(() => {
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const d = (input as Record<string, unknown>).description;
      if (typeof d === "string" && d.trim().length > 0) return d.trim();
    }
    const synth = synthesizeHeadline(toolName, input, { homeDir });
    if (typeof synth === "string" && synth.length > 0) return synth;
    return "";
  });

  // FRI-84: input rendering uses parsed `input` whenever available
  // (canonical, pretty-printable); during streaming `input` may be
  // undefined and only `inputPartialJson` is populated. Best-effort
  // parse so the user sees something structured if the partial happens
  // to be valid mid-stream (rare but common at object boundaries),
  // otherwise raw.
  let inputText = $derived.by(() => {
    if (input !== undefined && input !== null) return fmtInput(input);
    const partial = inputPartialJson ?? "";
    if (partial.length === 0) return "";
    try {
      return JSON.stringify(JSON.parse(partial), null, 2);
    } catch {
      return partial;
    }
  });
  let hasInput = $derived(inputText.length > 0 && inputText !== "{}");
  let hasOutput = $derived(typeof output === "string" && output.length > 0);
  // Collapsed by default for both running and terminal states. The only
  // difference vs. pre-FRI-84 is that during streaming the `inputText`
  // derived above falls back to `inputPartialJson`, so a running tool
  // with partial input is now expandable (it previously wasn't, because
  // canonical `input` only landed at block_complete).
  let canExpand = $derived(hasInput || hasOutput);
  let open = $state(false);

  function badgeClass(s: string): string {
    if (s === "done") return "ok";
    if (s === "error") return "error";
    if (s === "aborted") return "muted";
    return "warn"; // running
  }
  function statusLabel(s: string): string {
    if (s === "running") return "running…";
    if (s === "done") return "done";
    if (s === "aborted") return "stopped";
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
    <span class="tool-icon" aria-hidden="true"><Wrench size={16} /></span>
    {#if description}
      <span class="tool-description">{description}</span>
      <code class="tool-name tool-name-pill" title={toolName}>{toolName}</code>
    {:else}
      <code class="tool-name">{toolName}</code>
    {/if}
    <span class="badge {badgeClass(status)}">{statusLabel(status)}</span>
    {#if canExpand}
      <span class="expand-toggle" aria-hidden="true">{open ? "−" : "+"}</span>
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
    border-left: 2px solid var(--status-warn);
    padding: 0.25rem 0;
    font-size: 0.85rem;
  }
  .tool-head {
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
  .tool-head:disabled {
    cursor: default;
  }
  .tool-icon {
    display: inline-flex;
    align-items: center;
    color: var(--status-warn);
  }
  .tool-name {
    color: var(--accent-primary);
    font-family: var(--font-mono);
    font-size: 0.85rem;
    background: transparent;
    border: none;
    padding: 0;
  }
  .tool-description {
    color: var(--text-primary);
    font-size: 0.85rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .tool-name-pill {
    font-size: 0.7rem;
    padding: 0.05rem 0.4rem;
    background: var(--bg-tertiary);
    color: var(--text-tertiary);
    border-radius: var(--radius-sm);
    flex-shrink: 0;
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
  .tool-head:hover .expand-toggle {
    background: var(--bg-card);
    color: var(--text-secondary);
  }
  .block-section {
    margin: 0.4rem 0.75rem 0.25rem 1.25rem;
    padding: 0.5rem 0.75rem;
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
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
