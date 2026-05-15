/**
 * Tiny one-shot bridge for components outside `ChatInput.svelte` that need
 * to push text into its textarea — today only the queued-bubble cancel-X
 * affordance, which yanks a queued message out of the daemon's `nextPrompts`
 * FIFO and stuffs the recovered prompt back into the input bar for the
 * user to edit.
 *
 * ChatInput registers a sink on mount; any component calls
 * `chatInputBridge.prepend(text)` and the sink runs synchronously, dropping
 * the text in front of whatever the user has already typed (separated by a
 * blank line when non-empty) and parking the caret at the end of the
 * recovered text.
 *
 * Plain function reference instead of a Svelte store because there's no
 * reactive state to subscribe to and exactly one writer at a time —
 * ChatInput is the focused input, and the most recently mounted one wins.
 */
type PrependSink = (text: string) => void;

let sink: PrependSink | null = null;

export const chatInputBridge = {
  /**
   * Register the textarea-owning component as the active sink. Returns an
   * unregister function callers should fire in `onDestroy` so a swapped-out
   * component doesn't leave a stale reference behind. If a previous sink is
   * still registered we replace it — last-mount wins, matching the
   * dashboard's single-input layout.
   */
  register(fn: PrependSink): () => void {
    sink = fn;
    return () => {
      if (sink === fn) sink = null;
    };
  },
  /**
   * Prepend `text` to the active input. No-op when no sink is registered
   * (e.g. the queued bubble's cancel-X clicked before ChatInput mounts,
   * which shouldn't happen in practice but is harmless if it does).
   */
  prepend(text: string): void {
    if (sink) sink(text);
  },
};
