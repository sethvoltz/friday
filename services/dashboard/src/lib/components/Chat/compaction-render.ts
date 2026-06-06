// Pure render helpers for the durable compaction divider + "viewing
// pre-compaction history" pill (FRI-156 §E/§F).
//
// These live in a sibling `.ts` module (not a `<script module>` export from a
// Svelte component) so they are unambiguously importable under the dashboard's
// node/forks vitest pool, which has no vite-svelte plugin and no DOM. The
// optimistic↔canonical convergence rule and the pill-visibility geometry are
// the two stateful seams worth pinning here; ChatMessages.svelte / chat.svelte
// consume them, and the unit test exercises them directly. Mirrors the
// todo-render.ts precedent (FRI-133).

import type { ChatMessage } from "$lib/stores/chat.svelte";

/** Stable, unique id for a compaction divider derived from its durable
 *  block. Used by both `parseBlocks` (reload) and any live render path so
 *  the two converge on a single keyed {@link ChatMessage} — two dividers
 *  sharing an id crashes the keyed `{#each}`. Mirrors the `cb_<blockId>`
 *  convention `parseBlocks` emits. */
export function compactionDividerId(blockId: string): string {
  return `cb_${blockId}`;
}

/**
 * Optimistic↔canonical convergence invariant for compaction dividers: a
 * given turn must render AT MOST one divider, regardless of the order in
 * which signals arrive (the live `compacting` SSE event vs. the durable
 * `kind:'compaction'` block row replicated via Zero). Returns the count of
 * distinct compaction dividers in the list, grouped by turnId.
 *
 * The live path emits NO divider (only a transient spinner keyed on the
 * compacting agent), so the only divider producer is the persisted block —
 * which `parseBlocks` keys by `cb_<blockId>`. This helper makes that
 * structural guarantee testable in both interleavings: whether the block or
 * the live status is observed first, the divider set is identical because it
 * is derived solely from the block rows.
 */
export function compactionDividerCountByTurn(messages: ChatMessage[]): Map<string, number> {
  const seenIds = new Set<string>();
  const byTurn = new Map<string, number>();
  for (const m of messages) {
    if (m.kind !== "compaction") continue;
    // De-dupe by id first: a keyed {#each} would crash on a duplicate id, so
    // a list that somehow carries two messages with the same `cb_<blockId>`
    // is itself the bug — count distinct ids only.
    if (seenIds.has(m.id)) continue;
    seenIds.add(m.id);
    const turn = m.turnId ?? "";
    byTurn.set(turn, (byTurn.get(turn) ?? 0) + 1);
  }
  return byTurn;
}

/**
 * Pill-visibility geometry: the "Viewing pre-compaction history" pill shows
 * when the user is scrolled ABOVE the most-recent divider — i.e. the divider
 * sits at or below the bottom edge of the scroller viewport. Expressed as a
 * pure predicate over the divider's top offset and the viewport bottom so the
 * IntersectionObserver callback in ChatMessages.svelte has a unit-testable
 * core. `dividerTop` and `viewportBottom` are both in client (viewport)
 * pixels, matching `DOMRectReadOnly.top` / `rootBounds.bottom`.
 */
export function isViewingPreCompaction(args: {
  /** The divider element's `boundingClientRect.top` (client px). */
  dividerTop: number;
  /** The scroller's viewport bottom (`rootBounds.bottom`, client px). */
  viewportBottom: number;
  /** Whether the divider element currently intersects the viewport. When
   *  it does, the user is looking at/below it → not pre-compaction. */
  isIntersecting: boolean;
}): boolean {
  if (args.isIntersecting) return false;
  return args.dividerTop >= args.viewportBottom;
}
