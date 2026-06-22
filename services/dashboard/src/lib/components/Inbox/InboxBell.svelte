<script lang="ts">
  /**
   * FRI-171 (ADR-047) — the header Inbox bell.
   *
   * Renders the bell button with a two-tone badge:
   *   - badge count = number of open Inbox items (`inbox.openCount`);
   *   - tone = `attention` (warm) iff any open Proposed/Unsorted item needs a
   *     decision, `low` (muted) when only open Done items remain (FYI+undo).
   *
   * Opening the bell fires `inbox.resolveOnView()` — the auto-resolve-on-view
   * that flips open Done items to resolved (seeing them in the bell IS the
   * acknowledgement) while leaving Proposed/Unsorted open for an explicit
   * decision. The {@link InboxPanel} renders the review surface.
   */
  import { Bell } from "lucide-svelte";
  import { inbox } from "$lib/stores/inbox.svelte";
  import InboxPanel from "./InboxPanel.svelte";

  let open = $state(false);
  let rootRef = $state<HTMLDivElement | null>(null);

  const count = $derived(inbox.openCount);
  const tone = $derived(inbox.tone);

  function toggle(): void {
    open = !open;
    // Opening the bell is the "view" event — resolve open Done items now.
    if (open) inbox.resolveOnView();
  }

  function close(): void {
    open = false;
  }

  // Outside-click / Escape dismissal, mirroring the header's nav-more menu.
  function onWindowPointer(e: PointerEvent): void {
    if (!open || !rootRef) return;
    if (!rootRef.contains(e.target as Node)) close();
  }
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && open) close();
  }
</script>

<svelte:window onpointerdown={onWindowPointer} onkeydown={onKeydown} />

<div class="inbox-bell" bind:this={rootRef}>
  <button
    type="button"
    class="bell-btn"
    class:has-attention={tone === "attention"}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label={count > 0 ? `Inbox — ${count} open item${count === 1 ? "" : "s"}` : "Inbox — empty"}
    title="Inbox"
    onclick={toggle}>
    <Bell size={16} strokeWidth={2} aria-hidden="true" />
    {#if count > 0}
      <span class="badge tone-{tone}" aria-hidden="true">{count > 99 ? "99+" : count}</span>
    {/if}
  </button>

  {#if open}
    <InboxPanel onclose={close} />
  {/if}
</div>

<style>
  .inbox-bell {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
  }
  .bell-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: relative;
    width: 2rem;
    height: 2rem;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .bell-btn:hover {
    color: var(--text-primary);
    background: var(--bg-tertiary);
  }
  .bell-btn.has-attention {
    color: var(--accent-primary);
  }
  .badge {
    position: absolute;
    top: -2px;
    right: -2px;
    min-width: 1rem;
    height: 1rem;
    padding: 0 0.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.65rem;
    font-weight: 700;
    line-height: 1;
    border-radius: 999px;
    color: #fff;
  }
  /* Two-tone: attention items use the accent (warm/loud); low-priority
     Done-only uses a muted token so the bell de-emphasizes itself. */
  .badge.tone-attention {
    background: var(--accent-primary);
  }
  .badge.tone-low {
    background: var(--text-tertiary, var(--text-secondary));
  }
</style>
