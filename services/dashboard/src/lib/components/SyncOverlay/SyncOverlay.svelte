<script lang="ts">
  import { zeroSync } from "$lib/stores/zero.svelte";
  import { browser } from "$app/environment";

  /**
   * Linear-style full-page sync overlay (item #58).
   *
   * Shown ONLY when Zero's initial sync genuinely takes long enough
   * that an empty chat shell would be jarring. The trigger logic:
   *
   *   1. `zeroSync.status === "pending"` — Zero hasn't materialized
   *      any view yet (the WS handshake, JWT mint, replication
   *      catch-up are all pending). On a fast network with a
   *      warm IDB this is sub-100ms and the overlay never paints.
   *   2. AND that pending state has lasted at least
   *      `OVERLAY_DELAY_MS` (default 500ms). A 100ms first-load
   *      doesn't flash an overlay; a 5-second cold IDB build does.
   *
   * On the first transition to "live" we lock the overlay shut for
   * the rest of the session — subsequent transient `pending` blips
   * (reconnects, JWT rotation) don't re-show the overlay because the
   * user already has the chat in front of them; covering it with
   * "Syncing…" would be wrong UX.
   */
  const OVERLAY_DELAY_MS = 500;

  let shown = $state(false);
  let everLive = $state(false);

  $effect(() => {
    if (!browser) return;
    if (everLive) return;
    const status = zeroSync.status;
    if (status === "live") {
      shown = false;
      everLive = true;
      return;
    }
    if (status === "error") {
      // An error during initial sync: show the overlay so the user
      // knows something's wrong (the ConnectivityWidget would also
      // surface it, but mid-sync the chat shell is empty and the
      // widget chip can be missed). No timer — error is immediate.
      shown = true;
      return;
    }
    // status === "pending"
    const t = setTimeout(() => {
      // Re-check at fire time — status could have flipped during the
      // delay window. If it's live, do nothing.
      if (zeroSync.status === "pending") shown = true;
    }, OVERLAY_DELAY_MS);
    return () => clearTimeout(t);
  });
</script>

{#if shown}
  <div class="sync-overlay" role="status" aria-live="polite">
    <div class="sync-card">
      <div class="spinner" aria-hidden="true"></div>
      <div class="copy">
        <p class="headline">
          {zeroSync.status === "error" ? "Sync error" : "Syncing your data"}
        </p>
        <p class="sub">
          {#if zeroSync.status === "error"}
            {zeroSync.errorMessage ?? "Couldn't reach the sync server."}
          {:else}
            One moment — bringing your chats, tickets, and memory up to date.
          {/if}
        </p>
      </div>
    </div>
  </div>
{/if}

<style>
  .sync-overlay {
    position: fixed;
    inset: 0;
    z-index: 500;
    background: rgba(8, 12, 20, 0.62);
    backdrop-filter: blur(12px) saturate(140%);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    animation: fade-in 0.18s ease;
  }
  @keyframes fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  .sync-card {
    display: flex;
    align-items: center;
    gap: 1rem;
    background: var(--bg-card);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    padding: 1rem 1.25rem;
    box-shadow: var(--shadow-lg);
    max-width: 28rem;
  }
  .spinner {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    border: 3px solid var(--border-primary);
    border-top-color: var(--accent-primary);
    animation: spin 0.9s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .copy {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }
  .headline {
    font-size: 0.95rem;
    font-weight: 600;
    margin: 0;
  }
  .sub {
    font-size: 0.8rem;
    color: var(--text-secondary);
    margin: 0;
    line-height: 1.4;
  }
</style>
