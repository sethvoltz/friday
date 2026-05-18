/**
 * Clock store regression tests.
 *
 * The clock drives every relative-timestamp + day-separator label across
 * the chat — a broken tick means every "Today" / "2:14 PM" silently goes
 * stale, with no surfaced symptom. Stateful behaviors covered here:
 *
 *   1. The tick advances `clock.now` to the wall-clock when the scheduled
 *      timer fires, and reschedules itself.
 *   2. `rehydrateClock()` advances `clock.now` immediately AND cancels +
 *      reschedules the pending timer. This is the path a
 *      `visibilitychange → visible` handler takes; if it didn't cancel
 *      the pending timer, a backgrounded tab that just woke up would have
 *      two timers racing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("clock store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances clock.now when the per-minute timer fires", async () => {
    const { clock, rehydrateClock } = await import("./clock.svelte");
    // Anchor a deterministic wall-clock. The store auto-started at module
    // load time, so its current `now` is the pre-fakeTimers Date.now();
    // rehydrate to re-align to the fake clock.
    vi.setSystemTime(new Date(2026, 4, 17, 14, 30, 0, 0));
    rehydrateClock();
    const start = clock.now;

    // Advance one minute. The aligned schedule + tick combo should fire
    // the tick callback exactly once and re-arm the timer.
    vi.advanceTimersByTime(60_000);

    expect(clock.now).toBeGreaterThanOrEqual(start + 30_000);
    expect(clock.now - start).toBeLessThanOrEqual(60_000);
  });

  it("rehydrateClock forces an immediate update and reschedules", async () => {
    const { clock, rehydrateClock } = await import("./clock.svelte");
    vi.setSystemTime(new Date(2026, 4, 17, 14, 30, 0, 0));
    rehydrateClock();
    const beforeJump = clock.now;

    // Jump the wall-clock forward by 5 minutes — simulates the user
    // returning to a tab that the browser had throttled. Without
    // rehydrate, clock.now would still equal beforeJump.
    vi.setSystemTime(new Date(2026, 4, 17, 14, 35, 0, 0));
    rehydrateClock();

    expect(clock.now - beforeJump).toBe(5 * 60_000);

    // And the rescheduled timer still fires correctly: another
    // advance-by-1-minute should bump clock.now further.
    const afterRehydrate = clock.now;
    vi.advanceTimersByTime(60_000);
    expect(clock.now).toBeGreaterThan(afterRehydrate);
  });
});
