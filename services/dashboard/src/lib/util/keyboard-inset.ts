/**
 * Soft-keyboard geometry tracker — the single owner of the visual-
 * viewport anchor vars and the `keyboard-open` root class (ADR-040).
 *
 * While a text-entry element is focused, it writes on `:root`:
 *
 *   --vv-top-y    = vv.offsetTop            (header / dropdown anchor)
 *   --vv-bottom-y = vv.offsetTop + vv.height (composer bottom anchor —
 *                   where iOS claims the keyboard's top edge sits, in
 *                   layout-viewport coordinates)
 *   --kb-inset    = max(0, innerHeight − vv.height)
 *                   (transcript scroll-headroom padding + jump pill;
 *                   deliberately pan-free so it is scroll-stable)
 *
 * No field focused → all vars cleared; the bars are plain fixed
 * elements with zero keyboard JS influence.
 *
 * The model was established against ON-DEVICE TELEMETRY (iOS 26.5
 * Safari, bottom URL bar): geometry snapshots cross-checked against the
 * composer's measured getBoundingClientRect and a `?kbdebug` probe
 * ladder photographed on the device. Hard-won facts — each reversed at
 * least one plausible-but-wrong revision (see ADR-040's rejected
 * alternatives and the telemetry-replay tests):
 *
 *   - PRESENCE is focus-derived, never geometry-derived: viewport
 *     height deltas read 0 in the resize regimes (standalone PWA,
 *     Android `interactive-widget=resizes-content`) and false-positive
 *     on URL-bar collapse during scroll.
 *   - `vv.offsetTop`, RAW, is the only honest pan source. `pageTop`
 *     mirrors scrollY and drops the pan. Do not clamp the pan to
 *     innerHeight − vv.height: with the keyboard up, iOS 26.5 shrinks
 *     the layout viewport and parks it, then pans the vv BEYOND its
 *     bottom — fixed elements positioned past innerHeight render there.
 *   - Re-measure on vv.resize AND vv.scroll AND window.resize
 *     (innerHeight can change with no vv event at keyboard-animation
 *     end), rAF-coalesced (WebKit #237851), change-guarded writes, plus
 *     timed post-focus settle probes for silent settles.
 *   - On settled blur: clear everything and fire a net-zero 1px scroll
 *     wiggle (WebKit #297779 — offsetTop can stick after dismissal).
 *
 * Known platform ceiling (accepted in ADR-040): in a Safari TAB's
 * parked first-tap state, the claimed vv.height under-reports the truly
 * visible area by a floating chrome allowance no web API exposes
 * (CSSWG #7475). The composer sits exactly at the claimed boundary.
 * The standalone PWA and Android are unaffected.
 */

const FOCUS_SETTLE_MS = 100;

/** Sanity clamp for the PADDING inset only: no phone keyboard exceeds
 * ~60% of the screen; a larger ih−vvh reading is a mid-transition
 * frame. (The anchors are deliberately NOT clamped — see module doc.) */
const MAX_INSET_FRACTION = 0.6;

export interface KeyboardInsetHost {
  /** window.innerHeight at read time. */
  innerHeight(): number;
  /** visualViewport geometry at read time; null when the API is absent.
   * offsetTop is the pan source. On iOS 26.5 the API's three pan-related
   * values disagree, and cross-checking each candidate against the
   * composer's MEASURED getBoundingClientRect in on-device telemetry
   * showed `offsetTop` consistent with the rendered truth in every
   * sample, while `pageTop` simply mirrors scrollY and drops the pan.
   * Do not "fix" this back to pageTop − scrollY. */
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
  /** Measure once on startup so the geometry vars exist before focus. */
  init(): void;
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

  function clearVars() {
    write("--kb-inset", "0px");
    write("--vv-top-y", "");
    write("--vv-bottom-y", "");
  }

  function measure() {
    rafHandle = null;
    const vv = host.viewport();
    // ADR-041: the geometry is written ALWAYS, not just
    // while a field is focused — the `.chat-viewport` column is sized to
    // --vv-bottom-y in every state so the composer clears the iOS bottom
    // URL bar (keyboard closed) and the keyboard (open) uniformly. Only
    // the `keyboard-open` CLASS stays focus-gated (it zeroes the
    // home-indicator safe-area while typing).
    if (!vv) {
      clearVars();
      return;
    }
    // The pan is RAW vv.offsetTop, unclamped. Two on-device findings
    // (iOS 26.5, verified by cross-checking the composer's rendered
    // getBoundingClientRect against each API value):
    //   1. offsetTop is the honest pan; pageTop mirrors scrollY and
    //      drops it. (An earlier revision derived the pan from
    //      pageTop − scrollY and froze the anchors.)
    //   2. With the keyboard up, iOS 26.5 SHRINKS the layout viewport
    //      (innerHeight 796 → 355) and parks it at the focus-time
    //      scroll position; further scrolling pans the visual viewport
    //      BEYOND the layout viewport's bottom (offsetTop 441 with
    //      innerHeight 355). That is real, renderable geometry —
    //      `position: fixed; top:` past innerHeight paints there, and
    //      the panned visual viewport shows it. An earlier revision
    //      clamped the pan to innerHeight − vv.height as "impossible"
    //      and threw every fixed bar off the top of the screen.
    const vvTop = Math.round(Math.max(0, vv.offsetTop));
    const vvBottom = Math.round(vvTop + vv.height);
    // Anchors for the fixed bars while the keyboard is up: the header /
    // agent dropdown pin under the visual viewport's top edge, the
    // composer sits on its bottom edge.
    write("--vv-top-y", `${vvTop}px`);
    write("--vv-bottom-y", `${vvBottom}px`);
    // Scroll-headroom inset for the transcript padding + jump pill.
    // innerHeight − vv.height, deliberately WITHOUT the pan: it is
    // nonzero only in the overlay regime (layout viewport keeps its
    // full height, so the keyboard eats scroll range that the padding
    // must give back) and 0 in the shrunk regime (iOS already extended
    // the scroll range by the shrink; padding there is pure blank space
    // — the "huge empty bottom" bug). Both terms are scroll-stable, so
    // the document height never changes under the user's finger.
    const innerH = host.innerHeight();
    const inset = Math.round(
      Math.min(Math.max(0, innerH - vv.height), innerH * MAX_INSET_FRACTION),
    );
    write("--kb-inset", `${inset}px`);
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
        // Do NOT clear the geometry — the column stays sized to the
        // visual viewport when the keyboard is closed. Re-measure so
        // --vv-bottom-y reflects the grown-back viewport, plus the
        // #297779 nudge.
        queueMeasure();
        host.nudgeScroll();
      }, FOCUS_SETTLE_MS);
    },

    onViewportChange() {
      // Always re-measure: the geometry vars track the visual viewport
      // in every state (keyboard or URL-bar). Change-guarded writes make
      // a no-op event free.
      queueMeasure();
    },

    /** Measure once on startup so the column is sized before any focus. */
    init() {
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
  // bottom-bar Safari).
  window.addEventListener("resize", onViewportChange);
  // Size the column before any focus (keyboard-closed visual viewport).
  tracker.init();

  return () => {
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    vv?.removeEventListener("resize", onViewportChange);
    vv?.removeEventListener("scroll", onViewportChange);
    window.removeEventListener("resize", onViewportChange);
    tracker.stop();
  };
}
