/**
 * Regression cover for the resync chase loop. The original bug:
 * after a chat resync (cold reload with existing history, or
 * past-session open), the chat scrolled to the bottom of cached
 * content and stopped — leaving the last turn roughly half a bubble
 * below the fold once the canonical Zero blocks snapshot arrived and
 * grew the rendered list. The fix chases the bottom across a bounded
 * window so each round of late content (Zero snapshot, image / iframe
 * loads, mermaid SVG mount, KaTeX layout, shiki settle) is followed
 * to the new bottom.
 *
 * These tests pin the chase contract:
 *   - it writes scrollTop on each rAF tick while the deadline is open;
 *   - it follows scrollHeight upward when content grows mid-chase
 *     (the actual bug repro);
 *   - it exits cleanly at the deadline;
 *   - it aborts on direct user scroll input (one-shot, not sticky);
 *   - it aborts on caller `abort()` (agent / session switch).
 */
import { describe, expect, it } from "vitest";
import { chaseScrollBottom, type ResyncChaseTarget } from "./resync-scroll";

interface Listener {
  type: string;
  fn: EventListener;
}

function makeTarget(initialHeight: number): {
  target: ResyncChaseTarget;
  setHeight: (h: number) => void;
  dispatch: (type: string) => void;
  scrollWrites: number[];
  listenerCount: () => number;
} {
  let scrollHeight = initialHeight;
  let scrollTop = 0;
  const listeners: Listener[] = [];
  const scrollWrites: number[] = [];

  const target: ResyncChaseTarget = {
    get scrollHeight() {
      return scrollHeight;
    },
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(v: number) {
      scrollTop = v;
      scrollWrites.push(v);
    },
    addEventListener(type, fn) {
      listeners.push({ type, fn });
    },
    removeEventListener(type, fn) {
      const idx = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (idx !== -1) listeners.splice(idx, 1);
    },
  };

  return {
    target,
    setHeight: (h) => {
      scrollHeight = h;
    },
    dispatch: (type) => {
      for (const l of listeners.filter((l) => l.type === type)) {
        l.fn(new Event(type));
      }
    },
    scrollWrites,
    listenerCount: () => listeners.length,
  };
}

/**
 * Synchronous rAF / now harness. `tick()` advances the clock and
 * fires the most-recently-scheduled frame callback. Mirrors the
 * "fake-timer + manual frame pump" pattern other dashboard tests use
 * for rAF-driven code.
 */
function makeClock() {
  let now = 1000;
  let pending: (() => void) | null = null;
  let nextHandle = 1;
  return {
    now: () => now,
    raf: (cb: () => void) => {
      pending = cb;
      return nextHandle++;
    },
    cancelRaf: () => {
      pending = null;
    },
    tick: (advanceMs: number) => {
      now += advanceMs;
      const cb = pending;
      pending = null;
      cb?.();
    },
    hasPending: () => pending !== null,
  };
}

describe("chaseScrollBottom", () => {
  it("writes scrollTop = scrollHeight on each frame while deadline is open", () => {
    const t = makeTarget(500);
    const clock = makeClock();
    chaseScrollBottom(t.target, {
      now: clock.now,
      raf: clock.raf,
      cancelRaf: clock.cancelRaf,
      durationMs: 300,
    });
    clock.tick(16);
    clock.tick(16);
    clock.tick(16);
    expect(t.scrollWrites).toEqual([500, 500, 500]);
  });

  it("follows scrollHeight upward when late content grows the scroller mid-chase", () => {
    // The actual bug: cached transcript renders at scrollHeight=500.
    // We scroll to 500. Then Zero snapshot lands and the list grows
    // to 800. Without the chase, scrollTop stays at 500 — half a turn
    // below the new bottom. With the chase, the next frame writes 800.
    const t = makeTarget(500);
    const clock = makeClock();
    chaseScrollBottom(t.target, {
      now: clock.now,
      raf: clock.raf,
      cancelRaf: clock.cancelRaf,
      durationMs: 800,
    });
    clock.tick(16); // initial cached-content bottom
    t.setHeight(800); // Zero snapshot arrives, list grows
    clock.tick(16);
    t.setHeight(950); // mermaid / image / late-mount tool result
    clock.tick(16);
    expect(t.scrollWrites).toEqual([500, 800, 950]);
  });

  it("stops scheduling frames once the deadline elapses", () => {
    const t = makeTarget(500);
    const clock = makeClock();
    let ended: string | null = null;
    chaseScrollBottom(t.target, {
      now: clock.now,
      raf: clock.raf,
      cancelRaf: clock.cancelRaf,
      durationMs: 100,
      onEnd: (reason) => {
        ended = reason;
      },
    });
    clock.tick(50);
    clock.tick(60); // crosses deadline (now = 110, deadline was 1100)
    expect(ended).toBe("deadline");
    expect(clock.hasPending()).toBe(false);
  });

  it.each(["wheel", "touchmove", "keydown"] as const)(
    "aborts on user %s input — one-shot, not sticky",
    (eventType) => {
      const t = makeTarget(500);
      const clock = makeClock();
      let ended: string | null = null;
      chaseScrollBottom(t.target, {
        now: clock.now,
        raf: clock.raf,
        cancelRaf: clock.cancelRaf,
        durationMs: 800,
        onEnd: (reason) => {
          ended = reason;
        },
      });
      clock.tick(16);
      t.dispatch(eventType);
      // Late content arrives AFTER user input — must not be chased.
      t.setHeight(2000);
      clock.tick(16);
      expect(ended).toBe("input");
      expect(t.scrollWrites).toEqual([500]);
    },
  );

  it("aborts on caller abort()", () => {
    const t = makeTarget(500);
    const clock = makeClock();
    let ended: string | null = null;
    const handle = chaseScrollBottom(t.target, {
      now: clock.now,
      raf: clock.raf,
      cancelRaf: clock.cancelRaf,
      durationMs: 800,
      onEnd: (reason) => {
        ended = reason;
      },
    });
    clock.tick(16);
    handle.abort();
    expect(ended).toBe("aborted");
    t.setHeight(2000);
    clock.tick(16);
    expect(t.scrollWrites).toEqual([500]);
  });

  it("removes its event listeners on exit (no leak across agent switches)", () => {
    const t = makeTarget(500);
    const clock = makeClock();
    const handle = chaseScrollBottom(t.target, {
      now: clock.now,
      raf: clock.raf,
      cancelRaf: clock.cancelRaf,
      durationMs: 100,
    });
    expect(t.listenerCount()).toBe(3); // wheel, touchmove, keydown
    handle.abort();
    expect(t.listenerCount()).toBe(0);
  });

  it("abort() is idempotent", () => {
    const t = makeTarget(500);
    const clock = makeClock();
    let endCount = 0;
    const handle = chaseScrollBottom(t.target, {
      now: clock.now,
      raf: clock.raf,
      cancelRaf: clock.cancelRaf,
      durationMs: 800,
      onEnd: () => {
        endCount++;
      },
    });
    handle.abort();
    handle.abort();
    handle.abort();
    expect(endCount).toBe(1);
  });

  it("handle.active reflects the current state", () => {
    const t = makeTarget(500);
    const clock = makeClock();
    const handle = chaseScrollBottom(t.target, {
      now: clock.now,
      raf: clock.raf,
      cancelRaf: clock.cancelRaf,
      durationMs: 200,
    });
    expect(handle.active).toBe(true);
    clock.tick(16);
    expect(handle.active).toBe(true);
    clock.tick(300);
    expect(handle.active).toBe(false);
  });
});
