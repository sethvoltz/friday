<script lang="ts">
  /**
   * FRI-142 (ADR-048): the in-app Toast Channel renderer.
   *
   * Reads the live `toasts` queue (fed by the SSE store's `toast` event — see
   * `lib/stores/toast.svelte.ts` + `sse.svelte.ts`) and renders a fixed,
   * newest-first stack. A toast is EPHEMERAL — never persisted, never in the
   * bell (the bell is the durable Inbox surface; the two converge only at the
   * badge count). The store owns the queue + auto-dismiss timing (6s for
   * `normal`, never for `critical`); this component only renders + routes.
   *
   * Click an actionable toast (one with a `deepLink`) → navigate to that route
   * (SvelteKit `goto`, same-origin) and dismiss it. The explicit ✕ dismisses
   * without navigating. Mounted once in the root layout, signed-in only.
   */
  import { toasts } from "$lib/stores/toast.svelte";
  import { goto } from "$app/navigation";
  import { X } from "lucide-svelte";

  function onActivate(id: number, deepLink: string | undefined): void {
    if (deepLink) void goto(deepLink);
    toasts.dismiss(id);
  }

  function onKey(e: KeyboardEvent, id: number, deepLink: string | undefined): void {
    // A toast with a deepLink is an actionable button; Enter/Space activate it.
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate(id, deepLink);
    }
  }
</script>

{#if toasts.items.length > 0}
  <div class="toast-host" aria-live="polite" aria-relevant="additions">
    {#each toasts.items as t (t.id)}
      <!-- Actionable (has a deepLink) → an interactive role=button card that
           navigates on activate. Non-actionable → a plain role=status card.
           Split so each element's role is statically interactive/non — a
           single element with a conditional role+tabindex trips the a11y
           noninteractive-tabindex lint. -->
      {#if t.deepLink}
        <div
          class="toast actionable"
          class:critical={t.priority === "critical"}
          data-event-type={t.eventType}
          role="button"
          tabindex="0"
          onclick={() => onActivate(t.id, t.deepLink)}
          onkeydown={(e) => onKey(e, t.id, t.deepLink)}>
          <div class="toast-body">
            <span class="toast-title">{t.title}</span>
            {#if t.body}
              <span class="toast-text">{t.body}</span>
            {/if}
          </div>
          <button
            type="button"
            class="toast-dismiss"
            aria-label="Dismiss notification"
            onclick={(e) => {
              // Stop the click from also triggering the card's navigate handler.
              e.stopPropagation();
              toasts.dismiss(t.id);
            }}>
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      {:else}
        <div
          class="toast"
          class:critical={t.priority === "critical"}
          data-event-type={t.eventType}
          role="status">
          <div class="toast-body">
            <span class="toast-title">{t.title}</span>
            {#if t.body}
              <span class="toast-text">{t.body}</span>
            {/if}
          </div>
          <button
            type="button"
            class="toast-dismiss"
            aria-label="Dismiss notification"
            onclick={() => toasts.dismiss(t.id)}>
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .toast-host {
    position: fixed;
    top: 5.5rem;
    right: 1.5rem;
    z-index: 300;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: min(360px, calc(100vw - 3rem));
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.7rem 0.75rem;
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-left: 3px solid var(--accent-primary);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    animation: toast-in var(--transition-normal, 200ms) ease-out;
  }
  .toast.actionable {
    cursor: pointer;
    transition:
      border-color var(--transition-fast),
      box-shadow var(--transition-fast);
  }
  .toast.actionable:hover {
    border-color: var(--accent-primary);
  }
  .toast.actionable:focus-visible {
    outline: 2px solid var(--accent-primary);
    outline-offset: 2px;
  }
  /* Critical toasts never auto-dismiss (store-side); flag them louder. */
  .toast.critical {
    border-left-color: var(--status-error, var(--accent-primary));
  }
  .toast-body {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
    flex: 1 1 auto;
  }
  .toast-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-primary);
    line-height: 1.25;
  }
  .toast-text {
    font-size: 0.8rem;
    color: var(--text-secondary);
    line-height: 1.3;
    overflow-wrap: anywhere;
  }
  .toast-dismiss {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-tertiary);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .toast-dismiss:hover {
    color: var(--text-primary);
    background: var(--bg-tertiary);
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(-0.5rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @media (max-width: 640px) {
    .toast-host {
      top: 5rem;
      right: 1rem;
      left: 1rem;
      width: auto;
    }
  }
</style>
