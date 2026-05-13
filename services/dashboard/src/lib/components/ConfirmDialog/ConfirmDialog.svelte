<script lang="ts">
  import { AlertDialog } from "bits-ui";
  import { confirmState } from "./store.svelte";

  const current = $derived(confirmState.current);

  function onOpenChange(open: boolean) {
    if (!open) confirmState.resolve(false);
  }
</script>

{#if current}
  <AlertDialog.Root open={true} {onOpenChange}>
    <AlertDialog.Portal>
      <AlertDialog.Overlay class="confirm-overlay" />
      <AlertDialog.Content class="confirm-content">
        <AlertDialog.Title class="confirm-title">
          {current.title}
        </AlertDialog.Title>
        <AlertDialog.Description class="confirm-description">
          {current.description}
        </AlertDialog.Description>
        <div class="confirm-actions">
          <button
            type="button"
            class="ghost"
            onclick={() => confirmState.resolve(false)}>
            {current.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            class={current.danger ? "primary confirm-danger" : "primary"}
            onclick={() => confirmState.resolve(true)}>
            {current.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
{/if}

<style>
  :global(.confirm-overlay) {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
    z-index: 100;
  }

  :global(.confirm-content) {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 101;
    width: min(440px, calc(100vw - 2rem));
    background: var(--bg-elevated, var(--bg-secondary));
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    padding: 1.25rem 1.25rem 1rem;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  :global(.confirm-title) {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  :global(.confirm-description) {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.45;
    color: var(--text-secondary);
    white-space: pre-wrap;
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  :global(button.confirm-danger) {
    background: var(--status-error);
    color: var(--text-inverse, #fff);
  }
  :global(button.confirm-danger:hover) {
    background: var(--status-error);
    filter: brightness(1.1);
  }
</style>
