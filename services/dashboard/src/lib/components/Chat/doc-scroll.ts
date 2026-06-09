/**
 * Document-scroller seam for the chat route (FRI-160).
 *
 * The chat transcript is an inert in-flow block (`.chat-transcript`);
 * the DOCUMENT is the only scroller, matching every other route. The
 * old `position:fixed; overflow-y:auto` overlay intermittently lost
 * the touch-routing fight with the document on iOS/WebKit (the whole
 * view rubber-banded as a chunk instead of scrolling the chat).
 *
 * When the document scrolls, the `scroll` event fires at the document
 * and a `window` listener receives it; `window.scrollY` /
 * `window.scrollTo` / `window.scrollBy` are the matching read/write
 * surface. All chat scroll reads/writes go through these helpers so
 * ChatShell, ChatMessages, and the layout's router hook share one seam.
 *
 * NEVER pass a smooth `behavior` on the programmatic follow path
 * (WebKit #238497: smooth programmatic scrolls can silently no-op).
 * `/jump`'s user-initiated `scrollIntoView` is the one allowed smooth
 * scroll and lives outside this seam.
 *
 * SSR safety: every helper touches `window`/`document` at CALL time
 * only — importing this module during SSR is safe as long as calls
 * stay inside client-only code ($effect, onMount, event handlers).
 */

/** Snap the viewport to the bottom of the document. The follow path —
 * always `behavior:'auto'`, never smooth (see module doc). */
export function scrollToBottom(): void {
  window.scrollTo({
    top: document.documentElement.scrollHeight,
    behavior: "auto",
  });
}

/** Relative scroll adjustment (anchor-restore deltas). */
export function scrollByDelta(dy: number): void {
  window.scrollBy(0, dy);
}

/** Current document scroll position. */
export function readScrollY(): number {
  return window.scrollY;
}

/**
 * Defer a programmatic scroll write until after the next paint has
 * committed (double-rAF: the first callback runs before the upcoming
 * paint, so a callback scheduled from it runs after that paint).
 *
 * This replaces the old fixed-overlay scroller's `overflow-y:hidden`
 * paint-defer toggle: WebKit defers paint of a region revealed by a
 * programmatic scroll write that lands while the scroll thread is hot
 * (mid-momentum or just-stopped). With the document as the scroller
 * there is no element overflow to toggle — and `overflow:hidden` on
 * `<html>`/`<body>` is unreliable on iOS WebKit anyway (#153852,
 * #240860: the body stays scrollable). Deferring the write past the
 * in-flight frame lets the resized layout commit first, so the write
 * lands on settled geometry.
 *
 * Returns a cancel function. The document scroller is GLOBAL — unlike
 * the old per-component scroller element, whose queued writes died
 * with the element, a deferred write queued here outlives the view
 * that queued it and would land 1–2 frames later against whatever is
 * then on screen (e.g. a stale anchor-restore `scrollBy` yanking the
 * viewport right after a jump-to-bottom or a session switch). Callers
 * that queue corrections MUST hold the cancel handle and invalidate it
 * when scroll ownership changes (jump-to-bottom, chase start,
 * component teardown). Canceling after the callback has fired is a
 * safe no-op.
 */
export function afterNextPaint(fn: () => void): () => void {
  let raf2 = 0;
  const raf1 = requestAnimationFrame(() => {
    raf2 = requestAnimationFrame(fn);
  });
  return () => {
    cancelAnimationFrame(raf1);
    if (raf2 !== 0) cancelAnimationFrame(raf2);
  };
}
