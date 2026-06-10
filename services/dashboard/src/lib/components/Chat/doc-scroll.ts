/**
 * Chat scroll seam.
 *
 * ADR-041: the chat route uses an INNER
 * scroller element again (a height-constrained `.chat-scroller` inside a
 * visual-viewport-sized flex column), not the document. The body does
 * not scroll on the chat route, so iOS never pans the visual viewport
 * during scroll — the composer is laid out at the bottom of the column
 * and never has to chase the keyboard (killing the document-scroll
 * stutter). This reverses the FRI-160/ADR-039 document-scroll decision
 * for the chat route specifically; see the spike's evaluation before
 * promoting.
 *
 * All chat scroll reads/writes go through this one seam. The active
 * scroller is set by ChatShell on mount via `setChatScroller`; until
 * then (and on non-chat routes, and in SSR-safe call ordering) the
 * helpers fall back to the document/window so nothing throws.
 *
 * NEVER pass a smooth `behavior` on the programmatic follow path
 * (WebKit #238497). `/jump`'s user-initiated `scrollIntoView` is the one
 * allowed smooth scroll and lives outside this seam.
 */

let scroller: HTMLElement | null = null;

/** Set (or clear, with null) the chat route's inner scroller element. */
export function setChatScroller(el: HTMLElement | null): void {
  scroller = el;
}

/** The active scroller element, or null when falling back to the window. */
export function getChatScroller(): HTMLElement | null {
  return scroller;
}

/**
 * IntersectionObserver `root` for the chat sentinels: the scroller
 * element when set, `null` (viewport) as the SSR-safe fallback.
 */
export function chatScrollRoot(): Element | null {
  return scroller;
}

/** Snap the active scroller to the bottom. behavior:'auto' only. */
export function scrollToBottom(): void {
  if (scroller) {
    scroller.scrollTop = scroller.scrollHeight;
    return;
  }
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
}

/** Relative scroll adjustment (anchor-restore deltas). */
export function scrollByDelta(dy: number): void {
  if (scroller) {
    scroller.scrollTop += dy;
    return;
  }
  window.scrollBy(0, dy);
}

/** Current scroll position of the active scroller. */
export function readScrollY(): number {
  return scroller ? scroller.scrollTop : window.scrollY;
}

/** Bind a scroll listener to the active scroll surface. Returns an
 * unbind function. Falls back to `window` when no scroller is set. */
export function onChatScroll(handler: () => void): () => void {
  const target: EventTarget = scroller ?? window;
  target.addEventListener("scroll", handler, { passive: true });
  return () => target.removeEventListener("scroll", handler);
}

/**
 * Defer a programmatic scroll write until after the next paint has
 * committed (double-rAF). Returns a cancel function; cancelling after
 * the callback fires is a safe no-op. Deferred writes let a resized
 * layout commit before the write lands (the FRI-160 rationale carries
 * over to the inner scroller).
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
