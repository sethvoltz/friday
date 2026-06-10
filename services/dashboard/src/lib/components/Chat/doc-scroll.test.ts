// Pins the cancellation contract of afterNextPaint and the active-
// scroller seam (ADR-041). The chat scroller is a settable element; the
// helpers route reads/writes to it (window fallback before it's set).
// afterNextPaint's cancel handle lets ChatShell invalidate pending
// corrections on jump-to-bottom, chase start, and teardown — a
// regression that drops the handle reintroduces the stale-scrollBy bug.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  afterNextPaint,
  setChatScroller,
  getChatScroller,
  chatScrollRoot,
  scrollToBottom,
  scrollByDelta,
  readScrollY,
  onChatScroll,
} from "$lib/components/Chat/doc-scroll";

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

describe("active-scroller seam (ADR-041)", () => {
  interface FakeScroller {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    listenerCount(t: string): number;
  }
  function fakeScroller(): FakeScroller {
    const listeners = new Map<string, Set<EventListener>>();
    return {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400,
      addEventListener: vi.fn((t: string, l: EventListener) => {
        (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(l);
      }),
      removeEventListener: vi.fn((t: string, l: EventListener) => {
        listeners.get(t)?.delete(l);
      }),
      listenerCount: (t: string) => listeners.get(t)?.size ?? 0,
    };
  }
  const asEl = (f: FakeScroller) => f as unknown as HTMLElement;

  afterEach(() => setChatScroller(null));

  it("set/get/clear the active scroller; chatScrollRoot returns it (or null)", () => {
    expect(getChatScroller()).toBeNull();
    expect(chatScrollRoot()).toBeNull();
    const el = fakeScroller();
    setChatScroller(asEl(el));
    expect(getChatScroller()).toBe(el);
    expect(chatScrollRoot()).toBe(el);
    setChatScroller(null);
    expect(getChatScroller()).toBeNull();
  });

  it("scrollToBottom writes the element's scrollHeight to its scrollTop", () => {
    const el = fakeScroller();
    el.scrollHeight = 1234;
    setChatScroller(asEl(el));
    scrollToBottom();
    expect(el.scrollTop).toBe(1234);
  });

  it("scrollByDelta and readScrollY operate on the element's scrollTop", () => {
    const el = fakeScroller();
    el.scrollTop = 100;
    setChatScroller(asEl(el));
    scrollByDelta(40);
    expect(el.scrollTop).toBe(140);
    expect(readScrollY()).toBe(140);
  });

  it("onChatScroll binds/unbinds a scroll listener on the element", () => {
    const el = fakeScroller();
    setChatScroller(asEl(el));
    const handler = vi.fn();
    const unbind = onChatScroll(handler);
    expect(el.listenerCount("scroll")).toBe(1);
    unbind();
    expect(el.listenerCount("scroll")).toBe(0);
  });

  it("falls back to window when no scroller is set (SSR-safe call ordering)", () => {
    // The dashboard vitest pool is plain node (no window/document) — stub
    // them so the fallback branch is exercisable.
    const scrollTo = vi.fn();
    vi.stubGlobal("window", { scrollTo, scrollBy: vi.fn(), scrollY: 0 });
    vi.stubGlobal("document", { documentElement: { scrollHeight: 555 } });
    setChatScroller(null);
    scrollToBottom();
    expect(scrollTo).toHaveBeenCalledWith({ top: 555, behavior: "auto" });
  });
});
