<script lang="ts">
  import { Timer } from "lucide-svelte";
  import { badgeClass, statusLabel } from "./tool-status";
  import CollapsibleSection from "./CollapsibleSection.svelte";
  import { formatDelay } from "./schedule-wakeup-block";

  // Purpose-built renderer for the ScheduleWakeup built-in tool.
  // Registered in tool-renderers.ts on the literal key "ScheduleWakeup".
  //
  // Accepts all seven ToolRendererProps so the spread at the dispatch site
  // (ChatMessages.svelte) neither drops data nor warns under svelte-check.
  // `friendlyName` / `output` / `toolId` are intentionally unused.
  interface Props {
    toolName: string;
    friendlyName?: string;
    status: "running" | "done" | "error" | "aborted";
    input?: unknown;
    inputPartialJson?: string;
    output?: string;
    toolId?: string;
  }
  let { status, input, inputPartialJson }: Props = $props();

  function asObj(v: unknown): Record<string, unknown> | undefined {
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return undefined;
  }

  // Canonical `input` lands at block_complete; during streaming only
  // `inputPartialJson` is populated. Best-effort parse so the card is
  // populated as early as the partial JSON happens to be valid.
  let parsedInput = $derived.by(() => {
    if (input !== undefined && input !== null) return asObj(input);
    const partial = inputPartialJson ?? "";
    if (partial.length === 0) return undefined;
    try {
      return asObj(JSON.parse(partial));
    } catch {
      return undefined;
    }
  });

  let reason = $derived(
    typeof parsedInput?.reason === "string" && parsedInput.reason.length > 0
      ? parsedInput.reason
      : "Scheduling wake-up",
  );
  let delaySeconds = $derived(
    typeof parsedInput?.delaySeconds === "number" ? parsedInput.delaySeconds : undefined,
  );
  let prompt = $derived(
    typeof parsedInput?.prompt === "string" && parsedInput.prompt.length > 0
      ? parsedInput.prompt
      : undefined,
  );

  let delayText = $derived(delaySeconds !== undefined ? formatDelay(delaySeconds) : "");
  // Override "done" label — "woke up" is more meaningful than the generic "done".
  let effectiveLabel = $derived(status === "done" ? "woke up" : statusLabel(status));

  let canExpand = $derived(!!prompt);
  let open = $state(false);
</script>

<div class="tool-block">
  <button
    type="button"
    class="tool-head"
    onclick={() => canExpand && (open = !open)}
    aria-expanded={canExpand ? open : undefined}
    disabled={!canExpand}>
    <span class="tool-icon" aria-hidden="true"><Timer size={16} /></span>
    <span class="tool-description">{reason}</span>
    {#if delayText}
      <code class="tool-name tool-name-pill">{delayText}</code>
    {/if}
    <span class="badge {badgeClass(status)}">{effectiveLabel}</span>
    {#if canExpand}
      <span class="expand-toggle" aria-hidden="true">{open ? "−" : "+"}</span>
    {/if}
  </button>
  {#if open && prompt}
    <div class="block-section">
      <div class="block-label">Prompt</div>
      <CollapsibleSection collapsedMaxHeight={300}>
        <pre class="block-pre"><code>{prompt}</code></pre>
      </CollapsibleSection>
    </div>
  {/if}
</div>

<style>
  .tool-block {
    border-left: 2px solid var(--accent-primary);
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
    color: var(--accent-primary);
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
  .tool-name {
    color: var(--accent-primary);
    font-family: var(--font-mono);
    font-size: 0.85rem;
    background: transparent;
    border: none;
    padding: 0;
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
