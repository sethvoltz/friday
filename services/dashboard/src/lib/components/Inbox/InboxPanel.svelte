<script lang="ts">
  /**
   * FRI-171 (ADR-047) — the Inbox review panel (the bell's dropdown surface).
   *
   * Lists OPEN items by kind, each with the right CTA per the routing model:
   *   - Proposed → Approve (runs the executor server-side) / Reject (confirm).
   *   - Unsorted → Triage (mail to a chosen registry agent) / Dismiss (confirm).
   *   - Done     → Undo (when undoable; tooltip = inverse_label) OR View
   *                (when not undoable; deep-link to the artifact).
   *
   * Destructive confirms (Reject, Dismiss) use the project's ConfirmDialog
   * modal — NEVER window.confirm.
   */
  import { inbox } from "$lib/stores/inbox.svelte";
  import { chat } from "$lib/stores/chat.svelte";
  import { confirmDialog } from "$lib/components/ConfirmDialog/store.svelte";
  import { Check, X, RotateCcw, ExternalLink, Send } from "lucide-svelte";

  let { onclose }: { onclose: () => void } = $props();

  const byKind = $derived(inbox.openByKind);

  let error = $state<string | null>(null);
  /** id whose Triage target picker is open. */
  let triagingId = $state<string | null>(null);

  // Agent registry targets for Triage: every non-archived agent, as
  // `agent:<name>` ids. The classifier already offers core targets; manual
  // triage routes an unclassified Capture to an agent by mail.
  const agentTargets = $derived(
    chat.agents
      .filter((a) => a.status !== "archived")
      .map((a) => ({ id: `agent:${a.name}`, name: a.name })),
  );

  async function approve(id: string): Promise<void> {
    error = null;
    try {
      await inbox.approve(id);
    } catch (e) {
      error = e instanceof Error ? e.message : "approve failed";
    }
  }

  async function reject(id: string): Promise<void> {
    const ok = await confirmDialog({
      title: "Reject this item?",
      description: "The proposed action won't run. The item is kept as a record but leaves the inbox.",
      confirmLabel: "Reject",
      danger: true,
    });
    if (ok) inbox.reject(id);
  }

  async function dismiss(id: string): Promise<void> {
    const ok = await confirmDialog({
      title: "Dismiss this item?",
      description: "The capture leaves the inbox without being routed. It is kept as a record.",
      confirmLabel: "Dismiss",
      danger: true,
    });
    if (ok) inbox.dismiss(id);
  }

  async function undo(id: string): Promise<void> {
    error = null;
    try {
      await inbox.undo(id);
    } catch (e) {
      error = e instanceof Error ? e.message : "undo failed";
    }
  }

  async function triage(id: string, targetId: string): Promise<void> {
    error = null;
    triagingId = null;
    try {
      await inbox.triage(id, targetId);
    } catch (e) {
      error = e instanceof Error ? e.message : "triage failed";
    }
  }

  // FRI-142 (ADR-048): `raw_text` is now nullable — a non-Intake producer
  // (Layer-3 prep) may write a row with no captured raw text. Prefer the
  // cleaned text, fall back to the raw text, and finally to an empty label so
  // the return type stays a string.
  function label(item: { cleaned_text: string | null; raw_text: string | null }): string {
    return item.cleaned_text ?? item.raw_text ?? "";
  }
</script>

<div class="inbox-panel" role="dialog" aria-label="Inbox">
  <header class="panel-head">
    <span class="panel-title">Inbox</span>
    <button type="button" class="close-btn" aria-label="Close inbox" onclick={onclose}>
      <X size={14} strokeWidth={2} aria-hidden="true" />
    </button>
  </header>

  {#if error}
    <p class="panel-error" role="alert">{error}</p>
  {/if}

  {#if inbox.openCount === 0}
    <p class="panel-empty">Nothing in the inbox.</p>
  {/if}

  {#if byKind.proposed.length > 0}
    <section class="kind-section">
      <h3 class="kind-head">Proposed</h3>
      {#each byKind.proposed as item (item.id)}
        <div class="item">
          <p class="item-text">{label(item)}</p>
          {#if item.rationale}<p class="item-meta">{item.rationale}</p>{/if}
          <div class="item-cta">
            <button type="button" class="cta primary" onclick={() => approve(item.id)}>
              <Check size={13} strokeWidth={2} aria-hidden="true" /> Approve
            </button>
            <button type="button" class="cta" onclick={() => reject(item.id)}>
              <X size={13} strokeWidth={2} aria-hidden="true" /> Reject
            </button>
          </div>
        </div>
      {/each}
    </section>
  {/if}

  {#if byKind.unsorted.length > 0}
    <section class="kind-section">
      <h3 class="kind-head">Unsorted</h3>
      {#each byKind.unsorted as item (item.id)}
        <div class="item">
          <p class="item-text">{label(item)}</p>
          {#if triagingId === item.id}
            <div class="triage-picker">
              {#each agentTargets as t (t.id)}
                <button type="button" class="cta" onclick={() => triage(item.id, t.id)}>
                  <Send size={13} strokeWidth={2} aria-hidden="true" /> {t.name}
                </button>
              {/each}
              <button type="button" class="cta ghost" onclick={() => (triagingId = null)}>
                Cancel
              </button>
            </div>
          {:else}
            <div class="item-cta">
              <button type="button" class="cta primary" onclick={() => (triagingId = item.id)}>
                <Send size={13} strokeWidth={2} aria-hidden="true" /> Triage
              </button>
              <button type="button" class="cta" onclick={() => dismiss(item.id)}>
                <X size={13} strokeWidth={2} aria-hidden="true" /> Dismiss
              </button>
            </div>
          {/if}
        </div>
      {/each}
    </section>
  {/if}

  {#if byKind.done.length > 0}
    <section class="kind-section">
      <h3 class="kind-head">Done</h3>
      {#each byKind.done as item (item.id)}
        <div class="item">
          <p class="item-text">{label(item)}</p>
          <div class="item-cta">
            {#if item.undoable}
              <button
                type="button"
                class="cta"
                title={item.inverse_label ?? "Undo"}
                onclick={() => undo(item.id)}>
                <RotateCcw size={13} strokeWidth={2} aria-hidden="true" />
                {item.inverse_label ?? "Undo"}
              </button>
            {:else if item.deep_link}
              <a class="cta" href={item.deep_link} onclick={onclose}>
                <ExternalLink size={13} strokeWidth={2} aria-hidden="true" /> View
              </a>
            {/if}
          </div>
        </div>
      {/each}
    </section>
  {/if}
</div>

<style>
  .inbox-panel {
    position: absolute;
    top: calc(100% + 0.5rem);
    right: 0;
    width: min(22rem, 90vw);
    max-height: min(32rem, 70vh);
    overflow-y: auto;
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.25));
    z-index: 60;
    padding: 0.5rem;
  }
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.25rem 0.5rem 0.5rem;
  }
  .panel-title {
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--text-primary);
  }
  .close-btn {
    display: inline-flex;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 0.15rem;
    border-radius: var(--radius-sm);
  }
  .close-btn:hover {
    color: var(--text-primary);
    background: var(--bg-tertiary);
  }
  .panel-error {
    margin: 0 0.5rem 0.5rem;
    padding: 0.4rem 0.5rem;
    font-size: 0.75rem;
    color: var(--danger, #e5484d);
    background: var(--danger-glow, rgba(229, 72, 77, 0.1));
    border-radius: var(--radius-sm);
  }
  .panel-empty {
    margin: 0.5rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
    text-align: center;
  }
  .kind-section {
    margin-bottom: 0.5rem;
  }
  .kind-head {
    margin: 0.25rem 0.5rem;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-tertiary, var(--text-secondary));
  }
  .item {
    padding: 0.5rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-primary);
    margin-bottom: 0.35rem;
    background: var(--bg-primary);
  }
  .item-text {
    margin: 0 0 0.25rem;
    font-size: 0.8rem;
    color: var(--text-primary);
    line-height: 1.35;
  }
  .item-meta {
    margin: 0 0 0.35rem;
    font-size: 0.7rem;
    color: var(--text-secondary);
  }
  .item-cta,
  .triage-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .cta {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.6rem;
    font-size: 0.72rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-primary);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    cursor: pointer;
    text-decoration: none;
    transition: all var(--transition-fast);
  }
  .cta:hover {
    color: var(--text-primary);
  }
  .cta.primary {
    background: var(--accent-glow);
    color: var(--accent-primary);
    border-color: var(--accent-primary);
  }
  .cta.ghost {
    background: transparent;
  }
</style>
