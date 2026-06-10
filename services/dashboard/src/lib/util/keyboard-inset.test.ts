/**
 * Stateful tests for the keyboard-inset tracker — the state machine
 * behind `--kb-inset` / `keyboard-open` (see keyboard-inset.ts for the
 * geometry model). Each test drives the tracker through a realistic
 * event interleaving for one viewport regime and asserts the WRITES
 * (var values + write counts + class toggles), not internals.
 */

import { describe, expect, it } from "vitest";
import {
  createKeyboardInsetTracker,
  isTextEntryElement,
  type KeyboardInsetHost,
} from "./keyboard-inset";

/** Deterministic host: manual rAF + timer queues, recorded writes. */
function makeHost(initial: {
  innerHeight: number;
  vvHeight: number;
  /** vv.offsetTop — the pan source (rect-verified honest on iOS 26.5). */
  vvPan?: number;
  hasViewport?: boolean;
}) {
  const state = {
    innerHeight: initial.innerHeight,
    vvHeight: initial.vvHeight,
    vvPan: initial.vvPan ?? 0,
    hasViewport: initial.hasViewport ?? true,
    activeElement: null as Element | null,
  };
  const writes: Array<[string, string]> = [];
  const classToggles: boolean[] = [];
  let nudges = 0;

  let rafSeq = 0;
  const rafQueue = new Map<number, () => void>();
  let timerSeq = 0;
  const timerQueue = new Map<number, () => void>();

  const host: KeyboardInsetHost = {
    innerHeight: () => state.innerHeight,
    viewport: () => (state.hasViewport ? { height: state.vvHeight, offsetTop: state.vvPan } : null),
    activeElement: () => state.activeElement,
    setVar: (name, value) => writes.push([name, value]),
    setKeyboardOpenClass: (on) => classToggles.push(on),
    nudgeScroll: () => nudges++,
    raf: (cb) => {
      rafSeq += 1;
      rafQueue.set(rafSeq, cb);
      return rafSeq;
    },
    cancelRaf: (h) => void rafQueue.delete(h),
    setTimeout: (cb) => {
      timerSeq += 1;
      timerQueue.set(timerSeq, cb);
      return timerSeq as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (h) => void timerQueue.delete(h as unknown as number),
  };

  return {
    host,
    state,
    writes,
    classToggles,
    nudgeCount: () => nudges,
    flushRaf() {
      const pending = [...rafQueue.values()];
      rafQueue.clear();
      for (const cb of pending) cb();
    },
    flushTimers() {
      const pending = [...timerQueue.values()];
      timerQueue.clear();
      for (const cb of pending) cb();
    },
    /** Latest --kb-inset write (the padding/pill offset). */
    lastVar: () => writes.filter((w) => w[0] === "--kb-inset").at(-1)?.[1],
    /** Latest --vv-bottom-y write (the composer anchor; "" = removed). */
    lastAnchor: () => writes.filter((w) => w[0] === "--vv-bottom-y").at(-1)?.[1],
    /** Latest --vv-top-y write (the header anchor; "" = removed). */
    lastTopAnchor: () => writes.filter((w) => w[0] === "--vv-top-y").at(-1)?.[1],
  };
}

/** Structural element fakes — the dashboard vitest pool runs in plain
 * node (no JSDOM); isTextEntryElement probes tagName/isContentEditable
 * structurally for exactly this reason (same convention as
 * pwa-platform.test.ts). */
function fakeEl(tagName: string, isContentEditable = false): Element {
  return { tagName, isContentEditable } as unknown as Element;
}
const fakeTextarea = () => fakeEl("TEXTAREA");

describe("isTextEntryElement", () => {
  it("accepts input, textarea, contenteditable; rejects buttons and null", () => {
    expect(isTextEntryElement(fakeEl("INPUT"))).toBe(true);
    expect(isTextEntryElement(fakeEl("TEXTAREA"))).toBe(true);
    expect(isTextEntryElement(fakeEl("DIV", true))).toBe(true);
    expect(isTextEntryElement(fakeEl("BUTTON"))).toBe(false);
    expect(isTextEntryElement(null)).toBe(false);
  });
});

describe("iOS Safari tab regime (innerHeight fixed, vv shrinks)", () => {
  it("focus → keyboard animates open via vv.resize → inset tracks to the settled keyboard height", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 844 });
    const t = createKeyboardInsetTracker(h.host);

    t.onFocusIn(fakeTextarea());
    expect(h.classToggles).toEqual([true]);
    h.flushRaf();
    // Keyboard hasn't started raising yet — geometry still full-height.
    expect(h.lastVar()).toBe("0px");

    // Mid-animation frame.
    h.state.vvHeight = 700;
    t.onViewportChange();
    h.flushRaf();
    expect(h.lastVar()).toBe("144px");

    // Settled.
    h.state.vvHeight = 526;
    t.onViewportChange();
    h.flushRaf();
    expect(h.lastVar()).toBe("318px");
  });

  it("Safari's reveal pan (vv.scroll → offsetTop) moves the anchors; the padding inset stays sticky", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 526 });
    const t = createKeyboardInsetTracker(h.host);
    t.onFocusIn(fakeTextarea());
    h.flushRaf();
    expect(h.lastAnchor()).toBe("526px");
    expect(h.lastTopAnchor()).toBe("0px");
    expect(h.lastVar()).toBe("318px");

    // Safari pans the visual viewport 100px down inside the layout
    // viewport — fires vv.scroll, no resize. Both bar anchors follow;
    // the padding inset is monotonic within the session (a padding that
    // shrinks mid-pan changes document height under the user's finger).
    h.state.vvPan = 100;
    t.onViewportChange();
    h.flushRaf();
    expect(h.lastAnchor()).toBe("626px");
    expect(h.lastTopAnchor()).toBe("100px");
    expect(h.lastVar()).toBe("318px");

    // Fully panned to the layout-viewport bottom.
    h.state.vvPan = 318;
    t.onViewportChange();
    h.flushRaf();
    expect(h.lastAnchor()).toBe("844px");
    expect(h.lastTopAnchor()).toBe("318px");
  });
});

describe("iOS 26.5 regimes (replayed from rect-verified on-device telemetry)", () => {
  it("overlay regime, shrunk-and-panned regime, and back — anchors track offsetTop raw, padding only tracks ih−vvh", () => {
    // Real sequence captured from the device (dashboard JSONL); every
    // expectation below was cross-checked against the composer's
    // measured getBoundingClientRect in the same snapshots.
    const h = makeHost({ innerHeight: 796, vvHeight: 796 });
    const t = createKeyboardInsetTracker(h.host);
    t.onFocusIn(fakeTextarea());
    h.flushRaf();

    // Keyboard opens (overlay): ih 796, vv 453, pan 0.
    h.state.vvHeight = 453;
    t.onViewportChange();
    h.flushRaf();
    expect(h.lastAnchor()).toBe("453px");
    expect(h.lastTopAnchor()).toBe("0px");
    expect(h.lastVar()).toBe("343px");

    // Overlay with reveal pan: vv pans 343 (= ih − vvh). Anchors ride;
    // padding inset (ih − vvh) is pan-independent — no document-height
    // change under the user's finger.
    h.state.vvPan = 343;
    t.onViewportChange();
    h.flushRaf();
    expect(h.lastAnchor()).toBe("796px");
    expect(h.lastTopAnchor()).toBe("343px");
    expect(h.lastVar()).toBe("343px");

    // Shrunk regime mid-scroll: iOS SHRINKS the layout viewport to the
    // visible height (ih 355 = vvh) and parks it at the focus-time
    // scroll position; the vv pans BEYOND its bottom (offsetTop 441 >
    // ih). This is real, renderable geometry — fixed elements placed
    // past innerHeight paint there and the panned vv shows them. The
    // device rect for the composer confirmed offsetTop, so the pan
    // passes through raw. Padding drops to 0: the shrink already
    // extended the scroll range, and keeping the overlay padding here
    // was the "huge blank space at the bottom" bug.
    h.state.innerHeight = 355;
    h.state.vvHeight = 355;
    h.state.vvPan = 441;
    t.onViewportChange();
    h.flushRaf();
    expect(h.lastTopAnchor()).toBe("441px");
    expect(h.lastAnchor()).toBe("796px");
    expect(h.lastVar()).toBe("0px");

    // Back to overlay settled (pan folded into scrollY by iOS).
    h.state.innerHeight = 796;
    h.state.vvHeight = 453;
    h.state.vvPan = 0;
    t.onViewportChange();
    h.flushRaf();
    expect(h.lastAnchor()).toBe("453px");
    expect(h.lastTopAnchor()).toBe("0px");
    expect(h.lastVar()).toBe("343px");
  });
});

describe("iOS 26 bottom-bar Safari: layout viewport resizes AFTER the last vv event", () => {
  it("a late innerHeight shrink (window.resize only, no vv event) keeps the anchor on the layout bottom", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 844 });
    const t = createKeyboardInsetTracker(h.host);
    t.onFocusIn(fakeTextarea());
    h.flushRaf();

    // vv shrinks first, mid-animation — overlay-regime reading.
    h.state.vvHeight = 526;
    t.onViewportChange();
    h.flushRaf();
    expect(h.lastAnchor()).toBe("526px");

    // Then the LAYOUT viewport resizes at animation end. No vv event —
    // only window.resize fires (wired to the same handler). The anchor
    // must land on the resized layout bottom (526), i.e. exactly where
    // the static bottom rule would put the composer.
    h.state.innerHeight = 526;
    t.onViewportChange();
    h.flushRaf();
    expect(h.lastAnchor()).toBe("526px");
    expect(h.lastTopAnchor()).toBe("0px");
  });

  it("settle probes re-measure even when NO event fires after the geometry settles", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 844 });
    const t = createKeyboardInsetTracker(h.host);
    t.onFocusIn(fakeTextarea());
    h.flushRaf();

    h.state.vvHeight = 526;
    h.state.vvPan = 100;
    // Geometry settles silently — no further events of any kind. The
    // post-focus settle probes pick the change up on a timetable.
    h.flushTimers();
    h.flushRaf();
    expect(h.lastAnchor()).toBe("626px");
    expect(h.lastTopAnchor()).toBe("100px");
  });
});

describe("iOS standalone PWA regime (innerHeight shrinks WITH vv)", () => {
  it("keyboard open reads inset 0 — fixed bars already cleared the keyboard natively", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 844 });
    const t = createKeyboardInsetTracker(h.host);
    t.onFocusIn(fakeTextarea());
    h.flushRaf();

    // Standalone: BOTH shrink together on keyboard open.
    h.state.innerHeight = 526;
    h.state.vvHeight = 526;
    t.onViewportChange();
    h.flushRaf();
    expect(h.lastVar()).toBe("0px");
    // keyboard-open class still applied (presence is focus-derived,
    // not geometry-derived) so --kb-safe-bottom zeroing still fires.
    expect(h.classToggles).toEqual([true]);
  });
});

describe("URL-bar collapse noise (the #230 regression class)", () => {
  it("vv.resize with NO field focused produces zero movement and zero extra writes", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 780 });
    const t = createKeyboardInsetTracker(h.host);

    t.onViewportChange();
    h.flushRaf();
    expect(h.writes).toEqual([["--kb-inset", "0px"]]);

    // Repeated collapse/expand cycles during scroll: geometry changes,
    // but unfocused → pinned to 0px, and the change-guard means NO
    // further style writes at all.
    for (const vvH of [844, 790, 844, 760]) {
      h.state.vvHeight = vvH;
      t.onViewportChange();
      h.flushRaf();
    }
    expect(h.writes).toHaveLength(1);
    expect(h.classToggles).toEqual([]);
  });
});

describe("blur settle + dismissal", () => {
  it("blur → settle window → inset 0, class removed, #297779 nudge fired", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 526 });
    const t = createKeyboardInsetTracker(h.host);
    t.onFocusIn(fakeTextarea());
    h.flushRaf();
    expect(h.lastVar()).toBe("318px");

    h.state.activeElement = fakeEl("BODY");
    t.onFocusOut();
    // Before the settle window elapses nothing has moved.
    expect(h.lastVar()).toBe("318px");
    h.flushTimers();
    expect(h.lastVar()).toBe("0px");
    expect(h.classToggles).toEqual([true, false]);
    expect(h.nudgeCount()).toBe(1);
  });

  it("field→field focus hop within the settle window keeps the keyboard state (no flash, no nudge)", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 526 });
    const t = createKeyboardInsetTracker(h.host);
    const ta = fakeTextarea();
    t.onFocusIn(ta);
    h.flushRaf();

    t.onFocusOut();
    // Focus lands on another field before the timer fires.
    const input = fakeEl("INPUT");
    h.state.activeElement = input;
    t.onFocusIn(input);
    h.flushTimers(); // any stale timer must be inert
    h.flushRaf();

    expect(h.lastVar()).toBe("318px");
    expect(h.classToggles).toEqual([true, true]);
    expect(h.nudgeCount()).toBe(0);
  });

  it("blur timer that fires while a field is active (focus moved without a focusin yet) is a no-op", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 526 });
    const t = createKeyboardInsetTracker(h.host);
    t.onFocusIn(fakeTextarea());
    h.flushRaf();

    h.state.activeElement = fakeTextarea(); // focus already on a field
    t.onFocusOut();
    h.flushTimers();
    expect(h.lastVar()).toBe("318px");
    expect(h.nudgeCount()).toBe(0);
  });
});

describe("composer anchor (--vv-bottom-y)", () => {
  it("equals offsetTop + vv.height and is COMPLETELY innerHeight-independent", () => {
    // The anchor must track the visual viewport regardless of what
    // innerHeight claims — including the shrunk regime where the pan
    // legitimately exceeds innerHeight − vv.height (rect-verified on
    // device). No clamping: an earlier clamped revision threw the
    // composer off the top of the screen in exactly that regime.
    for (const innerHeight of [430, 526, 844, 5000]) {
      const h = makeHost({ innerHeight, vvHeight: 430, vvPan: 100 });
      const t = createKeyboardInsetTracker(h.host);
      t.onFocusIn(fakeTextarea());
      h.flushRaf();
      expect(h.lastAnchor()).toBe("530px");
      expect(h.lastTopAnchor()).toBe("100px");
    }
  });

  it("is removed (not zeroed) on settled blur so the CSS falls back to the static bottom anchor", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 526 });
    const t = createKeyboardInsetTracker(h.host);
    t.onFocusIn(fakeTextarea());
    h.flushRaf();
    expect(h.lastAnchor()).toBe("526px");
    h.state.activeElement = fakeEl("BODY");
    t.onFocusOut();
    h.flushTimers();
    expect(h.lastAnchor()).toBe("");
  });
});

describe("write hygiene", () => {
  it("identical geometry across events produces exactly one write per var", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 526 });
    const t = createKeyboardInsetTracker(h.host);
    t.onFocusIn(fakeTextarea());
    h.flushRaf();
    t.onViewportChange();
    h.flushRaf();
    t.onViewportChange();
    h.flushRaf();
    expect(h.writes).toEqual([
      ["--vv-top-y", "0px"],
      ["--vv-bottom-y", "526px"],
      ["--kb-inset", "318px"],
    ]);
  });

  it("burst of events inside one frame coalesces to a single measure", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 526 });
    const t = createKeyboardInsetTracker(h.host);
    t.onFocusIn(fakeTextarea());
    t.onViewportChange();
    t.onViewportChange();
    t.onViewportChange();
    h.flushRaf();
    expect(h.writes).toEqual([
      ["--vv-top-y", "0px"],
      ["--vv-bottom-y", "526px"],
      ["--kb-inset", "318px"],
    ]);
  });

  it("fractional viewport heights round to integer px", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 526.6 });
    const t = createKeyboardInsetTracker(h.host);
    t.onFocusIn(fakeTextarea());
    h.flushRaf();
    expect(h.lastVar()).toBe("317px");
  });

  it("clamps a garbage mid-transition frame to 60% of innerHeight", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 100 });
    const t = createKeyboardInsetTracker(h.host);
    t.onFocusIn(fakeTextarea());
    h.flushRaf();
    expect(h.lastVar()).toBe(`${Math.round(844 * 0.6)}px`);
  });

  it("missing visualViewport API → inset stays 0", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 526, hasViewport: false });
    const t = createKeyboardInsetTracker(h.host);
    t.onFocusIn(fakeTextarea());
    h.flushRaf();
    expect(h.lastVar()).toBe("0px");
  });
});

describe("stop()", () => {
  it("cancels pending work and resets var + class", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 526 });
    const t = createKeyboardInsetTracker(h.host);
    t.onFocusIn(fakeTextarea());
    h.flushRaf();
    t.onFocusOut();
    t.stop();
    h.flushTimers(); // stale blur timer must have been cleared
    h.flushRaf();

    expect(h.lastVar()).toBe("0px");
    expect(h.classToggles.at(-1)).toBe(false);
    // stop() resets quietly — the #297779 nudge is a dismissal-only
    // workaround, not a teardown side effect.
    expect(h.nudgeCount()).toBe(0);
  });
});

describe("hardware keyboard (focus without viewport shrink)", () => {
  it("class applies but inset stays 0 — nothing lifts", () => {
    const h = makeHost({ innerHeight: 844, vvHeight: 844 });
    const t = createKeyboardInsetTracker(h.host);
    t.onFocusIn(fakeTextarea());
    h.flushRaf();
    expect(h.lastVar()).toBe("0px");
    expect(h.classToggles).toEqual([true]);
  });
});
