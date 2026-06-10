/**
 * Soft-keyboard inset tracker — the single owner of `--kb-inset` and the
 * `keyboard-open` root class.
 *
 * Geometry model (verified against WebKit behavior, June 2026):
 *
 *   `--kb-inset` = the height of the strip at the BOTTOM of the layout
 *   viewport that the soft keyboard obscures = how far a
 *   `position: fixed; bottom: 0` element must lift to clear it.
 *
 *     inset = max(0, innerHeight − vv.height − vv.offsetTop)
 *
 *   This one formula is correct across all three mobile regimes because
 *   each regime zeroes a different term:
 *
 *   - iOS Safari TAB: the keyboard is an overlay. `innerHeight` (layout
 *     viewport) does NOT shrink; `vv.height` does → inset = keyboard
 *     height. When Safari pans the visual viewport down inside the
 *     layout viewport (`vv.offsetTop` > 0, its focused-field reveal),
 *     the layout-viewport bottom comes back into view and the required
 *     lift shrinks by exactly `offsetTop`.
 *   - iOS STANDALONE PWA (home-screen app): the layout viewport itself
 *     resizes — `innerHeight` shrinks together with `vv.height` → inset
 *     ≈ 0, which is correct: `fixed; bottom: 0` already sits above the
 *     keyboard. (A delta heuristic like `innerHeight − vv.height > 100`
 *     can never detect the keyboard here; that is why keyboard PRESENCE
 *     is focus-derived, see below.)
 *   - Android Chrome 108+ / Firefox 132+ with
 *     `interactive-widget=resizes-content` (set in app.html): layout
 *     viewport resizes natively → inset ≈ 0, nothing to do.
 *
 * Keyboard PRESENCE is derived from text-field focus (`focusin` /
 * `focusout`), never from viewport geometry — geometry deltas read 0 in
 * the standalone regime and false-positive on URL-bar collapse. While no
 * text field is focused the inset is pinned to 0, so `vv.resize` noise
 * from URL-bar collapse/expand during scroll can never move the
 * composer (the bug that killed the previous ungated listener).
 *
 * Magnitude updates while focused come from `vv.resize` AND `vv.scroll`:
 * resize fires as the keyboard animates open (progressive lift for
 * free), scroll fires when Safari pans the visual viewport inside the
 * layout viewport, which changes the lift even though nothing resized.
 * Reads are rAF-coalesced — WebKit #237851: standalone mode can report
 * a stale `vv.offsetTop` in the same task as the event — and writes are
 * change-guarded so a no-op event never touches style (no layout
 * thrash, no bounce).
 *
 * Hardware-keyboard focus (no soft keyboard) self-corrects: the class
 * is applied but the viewport never shrinks, so the inset stays 0.
 *
 * `focusout` is debounced (FOCUS_SETTLE_MS) so focus hopping between
 * fields doesn't flash the layout. On a settled blur the inset drops to
 * 0 immediately and a net-zero 1px scroll wiggle works around WebKit
 * #297779 (iOS 26.0/26.1: `vv.offsetTop` sticks at ~24px after keyboard
 * dismissal, shifting every fixed bar until the next scroll).
 *
 * Consumers:
 *   - `.chat-input-floating` lifts by the inset (ChatShell.svelte);
 *   - `.chat-transcript` bottom padding reserves the inset so the last
 *     message can scroll above the lifted composer;
 *   - `.jump-to-bottom-wrap` mirrors the composer's offset;
 *   - `:root.keyboard-open` zeroes `--kb-safe-bottom` (app.css) — the
 *     keyboard covers the home-indicator zone, so stacking the safe-area
 *     inset on top of the keyboard inset would double-offset.
 */

const FOCUS_SETTLE_MS = 100;

/** Sanity clamp: no phone keyboard exceeds ~60% of the screen. A larger
 * reading means we caught the viewport mid-transition or mid-pinch-zoom;
 * clamping keeps a garbage frame from launching the composer off-screen. */
const MAX_INSET_FRACTION = 0.6;

export interface KeyboardInsetHost {
  /** window.innerHeight at read time. */
  innerHeight(): number;
  /** visualViewport geometry at read time; null when the API is absent. */
  viewport(): { height: number; offsetTop: number } | null;
  /** The element currently holding focus (document.activeElement). */
  activeElement(): Element | null;
  /** Write a custom property on :root. */
  setVar(name: string, value: string): void;
  /** Toggle the `keyboard-open` class on :root. */
  setKeyboardOpenClass(on: boolean): void;
  /** Net-zero scroll wiggle (WebKit #297779 workaround). */
  nudgeScroll(): void;
  raf(cb: () => void): number;
  cancelRaf(handle: number): void;
  setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export function isTextEntryElement(el: Element | null): boolean {
  if (!el) return false;
  // Structural (not instanceof) so the check is testable in the plain-
  // node vitest pool; SVG/foreign elements fall through on both probes.
  const tag = (el as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  return (el as HTMLElement).isContentEditable === true;
}

export interface KeyboardInsetTracker {
  /** Wire to document `focusin`. */
  onFocusIn(target: Element | null): void;
  /** Wire to document `focusout`. */
  onFocusOut(): void;
  /** Wire to visualViewport `resize` AND `scroll`, and to window
   * `resize`. ALL THREE inputs of the formula must trigger a
   * re-measure: `innerHeight` can change WITHOUT a visualViewport event
   * (iOS 26 bottom-bar Safari resizes the layout viewport at the END of
   * the keyboard animation, after the last vv.resize — a tracker that
   * only watches vv keeps the stale full-height innerHeight and
   * overshoots the lift by a full keyboard height). */
  onViewportChange(): void;
  /** Detach timers/rAF and reset the var + class. */
  stop(): void;
}

/** Post-focus settle probes. Keyboard open is a multi-actor animation
 * (keyboard slide, URL-bar collapse, layout-viewport resize) whose
 * events can land in any order — and the last actor to settle may not
 * fire an event the tracker hears. Re-measuring on a coarse timetable
 * after focus guarantees convergence to the settled geometry no matter
 * the event interleaving; the change-guard makes redundant probes
 * free. */
const SETTLE_PROBE_DELAYS_MS = [150, 350, 700, 1200];

export function createKeyboardInsetTracker(host: KeyboardInsetHost): KeyboardInsetTracker {
  let fieldFocused = false;
  let rafHandle: number | null = null;
  let blurTimer: ReturnType<typeof setTimeout> | null = null;
  let settleProbes: Array<ReturnType<typeof setTimeout>> = [];
  const lastWritten = new Map<string, string>();

  // Change-guarded var write. Empty string means "remove the property"
  // (mapped to style.removeProperty by the browser wiring).
  function write(name: string, value: string) {
    if ((lastWritten.get(name) ?? "") === value) return;
    lastWritten.set(name, value);
    host.setVar(name, value);
  }

  // Monotonic padding inset for the current keyboard session — see
  // measure(). Reset on blur/stop via clearVars().
  let stickyInset = 0;

  function clearVars() {
    stickyInset = 0;
    write("--kb-inset", "0px");
    write("--vv-top-y", "");
    write("--vv-bottom-y", "");
  }

  function measure() {
    rafHandle = null;
    const vv = host.viewport();
    if (!fieldFocused || !vv) {
      clearVars();
      return;
    }
    // On-device telemetry (iOS 26.5 Safari, bottom URL bar) showed the
    // SAME session flipping between two reporting modes while the
    // keyboard is up:
    //   Mode A (overlay): innerHeight stays full (796), vv.height
    //     shrinks (453), offsetTop pans 0..343.
    //   Mode B (resized, mid-scroll): innerHeight SHRINKS to ≈vv.height
    //     (355) but offsetTop retains a stale pan (441) — geometrically
    //     impossible (vv bottom 796 > layout bottom 355).
    // The fix is to clamp the pan into the only range that is
    // geometrically possible, 0..(innerHeight − vv.height). In Mode A
    // the clamp never binds (the real pan range is exactly that); in
    // Mode B it collapses the garbage pan to 0, which lands the anchor
    // on the resized layout bottom — exactly where a static bottom
    // anchor would sit, which is correct in a resized layout viewport.
    const innerH = host.innerHeight();
    const maxPan = Math.max(0, innerH - vv.height);
    const vvTop = Math.round(Math.min(Math.max(0, vv.offsetTop), maxPan));
    const vvBottom = Math.round(vvTop + vv.height);
    // Anchors for the fixed bars while the keyboard is up: the header /
    // agent dropdown pin under the visual viewport's top edge, the
    // composer sits on its bottom edge.
    write("--vv-top-y", `${vvTop}px`);
    write("--vv-bottom-y", `${vvBottom}px`);
    // Scroll-headroom inset for the transcript padding + jump pill.
    // MONOTONIC within one keyboard session (sticky max): the raw value
    // flips with the A/B mode changes mid-scroll, and a padding that
    // grows/shrinks 343px mid-gesture changes the document height under
    // the user's finger — the "content jumps around while scrolling"
    // bug. Held at the session max, it can only over-reserve (blank
    // scroll slack), never yank.
    const raw = innerH - vvBottom;
    const inset = Math.round(Math.min(Math.max(0, raw), innerH * MAX_INSET_FRACTION));
    stickyInset = Math.max(stickyInset, inset);
    write("--kb-inset", `${stickyInset}px`);
  }

  function queueMeasure() {
    if (rafHandle !== null) return;
    rafHandle = host.raf(measure);
  }

  function clearBlurTimer() {
    if (blurTimer !== null) {
      host.clearTimeout(blurTimer);
      blurTimer = null;
    }
  }

  function clearSettleProbes() {
    for (const t of settleProbes) host.clearTimeout(t);
    settleProbes = [];
  }

  function scheduleSettleProbes() {
    clearSettleProbes();
    settleProbes = SETTLE_PROBE_DELAYS_MS.map((ms) => host.setTimeout(queueMeasure, ms));
  }

  return {
    onFocusIn(target: Element | null) {
      if (!isTextEntryElement(target)) return;
      clearBlurTimer();
      fieldFocused = true;
      host.setKeyboardOpenClass(true);
      queueMeasure();
      scheduleSettleProbes();
    },

    onFocusOut() {
      clearBlurTimer();
      blurTimer = host.setTimeout(() => {
        blurTimer = null;
        // Focus may have hopped to another field within the settle
        // window (textarea → input) — keyboard never dismissed, keep
        // everything as-is.
        if (isTextEntryElement(host.activeElement())) return;
        clearSettleProbes();
        fieldFocused = false;
        host.setKeyboardOpenClass(false);
        clearVars();
        host.nudgeScroll();
      }, FOCUS_SETTLE_MS);
    },

    onViewportChange() {
      // Unfocused viewport noise (URL-bar collapse during scroll) takes
      // the measure() early-return to a guarded "0px" write — a no-op
      // after the first — so it can never move the layout.
      queueMeasure();
    },

    stop() {
      clearBlurTimer();
      clearSettleProbes();
      if (rafHandle !== null) {
        host.cancelRaf(rafHandle);
        rafHandle = null;
      }
      fieldFocused = false;
      host.setKeyboardOpenClass(false);
      clearVars();
    },
  };
}

/**
 * Browser wiring: binds the tracker to document/visualViewport events.
 * Returns a teardown. SSR-safe at call time only (touches window).
 */
export function startKeyboardInsetTracker(): () => void {
  const root = document.documentElement;
  const tracker = createKeyboardInsetTracker({
    innerHeight: () => window.innerHeight,
    viewport: () => {
      const vv = window.visualViewport;
      return vv ? { height: vv.height, offsetTop: vv.offsetTop } : null;
    },
    activeElement: () => document.activeElement,
    setVar: (name, value) =>
      value === "" ? root.style.removeProperty(name) : root.style.setProperty(name, value),
    setKeyboardOpenClass: (on) => root.classList.toggle("keyboard-open", on),
    nudgeScroll: () => {
      window.scrollBy(0, -1);
      window.scrollBy(0, 1);
    },
    raf: (cb) => requestAnimationFrame(cb),
    cancelRaf: (h) => cancelAnimationFrame(h),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h),
  });

  const onFocusIn = (e: FocusEvent) => tracker.onFocusIn(e.target as Element | null);
  const onFocusOut = () => tracker.onFocusOut();
  const onViewportChange = () => tracker.onViewportChange();

  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  const vv = window.visualViewport;
  vv?.addEventListener("resize", onViewportChange);
  vv?.addEventListener("scroll", onViewportChange);
  // innerHeight is a formula input and can change with NO vv event
  // (layout-viewport resize at keyboard-animation end on iOS 26
  // bottom-bar Safari). Focus-gated like everything else.
  window.addEventListener("resize", onViewportChange);

  return () => {
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    vv?.removeEventListener("resize", onViewportChange);
    vv?.removeEventListener("scroll", onViewportChange);
    window.removeEventListener("resize", onViewportChange);
    tracker.stop();
  };
}
