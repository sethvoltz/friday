// Pins the cancellation contract of afterNextPaint (FRI-160). The
// document scroller is global, so a queued deferred scroll write
// outlives the view that queued it — ChatShell relies on the returned
// cancel handle to invalidate pending corrections on jump-to-bottom,
// chase start, and teardown. A regression that drops the handle (or
// fires the callback anyway after cancel) reintroduces the
// stale-scrollBy-after-jump bug.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { afterNextPaint } from "$lib/components/Chat/doc-scroll";

// Manual rAF queue so the test controls frame boundaries exactly.
let rafQueue: Map<number, () => void>;
let nextHandle: number;

function flushFrame(): void {
  // Snapshot: callbacks scheduled DURING a frame run on the NEXT one,
  // matching real rAF semantics (this is what makes double-rAF span
  // two frames instead of collapsing into one).
  const current = [...rafQueue.entries()];
  rafQueue.clear();
  for (const [, cb] of current) cb();
}

beforeEach(() => {
  rafQueue = new Map();
  nextHandle = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const handle = nextHandle++;
    rafQueue.set(handle, () => cb(performance.now()));
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    rafQueue.delete(handle);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("afterNextPaint", () => {
  it("fires the callback on the second frame, not the first", () => {
    const fn = vi.fn();
    afterNextPaint(fn);
    flushFrame();
    expect(fn).not.toHaveBeenCalled();
    flushFrame();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel before the first frame prevents the callback", () => {
    const fn = vi.fn();
    const cancel = afterNextPaint(fn);
    cancel();
    flushFrame();
    flushFrame();
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel between the two frames prevents the callback", () => {
    const fn = vi.fn();
    const cancel = afterNextPaint(fn);
    flushFrame();
    cancel();
    flushFrame();
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel after the callback fired is a safe no-op", () => {
    const fn = vi.fn();
    const cancel = afterNextPaint(fn);
    flushFrame();
    flushFrame();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(() => cancel()).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
