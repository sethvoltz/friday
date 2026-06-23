/**
 * FRI-142 (ADR-048) — the live Toast queue (the SSE-fed Toast Channel sink).
 *
 * Stateful test: timers are faked; the store's real reactive `items` state is
 * asserted after each action. Pins the field mapping from the snake_case
 * `ToastEvent` wire shape, auto-dismiss timing, the critical-never-auto-dismiss
 * rule, the visible-stack cap, and manual dismissal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToastEvent } from "@friday/shared";
import { toasts } from "./toast.svelte";

function toastEvent(over: Partial<ToastEvent> = {}): ToastEvent {
  return {
    v: 1,
    seq: 1,
    type: "toast",
    title: "Builder finished",
    body: "seth/fri-142 archived",
    deep_link: "/agents/builder-1",
    event_type: "builder_archive",
    ts: Date.now(),
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  toasts.clear();
});

afterEach(() => {
  toasts.clear();
  vi.useRealTimers();
});

describe("toasts.push — wire mapping", () => {
  it("maps the snake_case ToastEvent fields onto a ToastItem", () => {
    toasts.push(toastEvent());
    expect(toasts.items).toHaveLength(1);
    const item = toasts.items[0];
    expect(item).toMatchObject({
      title: "Builder finished",
      body: "seth/fri-142 archived",
      deepLink: "/agents/builder-1", // deep_link → deepLink
      eventType: "builder_archive", // event_type → eventType
      priority: "normal", // omitted ⇒ normal
    });
    expect(typeof item.id).toBe("number");
  });

  it("defaults missing priority to normal and carries an explicit critical", () => {
    toasts.push(toastEvent({ priority: "critical", event_type: "evolve_critical" }));
    expect(toasts.items[0].priority).toBe("critical");
  });

  it("omits deepLink when the event is not actionable", () => {
    toasts.push(toastEvent({ deep_link: undefined }));
    expect(toasts.items[0].deepLink).toBeUndefined();
  });
});

describe("toasts auto-dismiss", () => {
  it("auto-dismisses a normal toast after 6s", () => {
    toasts.push(toastEvent());
    expect(toasts.items).toHaveLength(1);
    vi.advanceTimersByTime(6_000);
    expect(toasts.items).toHaveLength(0);
  });

  it("does NOT auto-dismiss a critical toast", () => {
    toasts.push(toastEvent({ priority: "critical" }));
    vi.advanceTimersByTime(60_000);
    expect(toasts.items).toHaveLength(1);
    expect(toasts.items[0].priority).toBe("critical");
  });
});

describe("toasts queue management", () => {
  it("orders newest-first", () => {
    toasts.push(toastEvent({ title: "first" }));
    toasts.push(toastEvent({ title: "second" }));
    expect(toasts.items.map((t) => t.title)).toEqual(["second", "first"]);
  });

  it("caps the visible stack at 4, dropping the oldest", () => {
    for (let i = 1; i <= 6; i++) toasts.push(toastEvent({ title: `t${i}` }));
    expect(toasts.items).toHaveLength(4);
    // Newest-first, oldest two (t1, t2) dropped.
    expect(toasts.items.map((t) => t.title)).toEqual(["t6", "t5", "t4", "t3"]);
  });

  it("dismiss removes a specific toast by id and clears its timer", () => {
    toasts.push(toastEvent({ title: "keep" }));
    toasts.push(toastEvent({ title: "drop" }));
    const dropId = toasts.items.find((t) => t.title === "drop")!.id;
    toasts.dismiss(dropId);
    expect(toasts.items.map((t) => t.title)).toEqual(["keep"]);
    // Advancing past the would-be auto-dismiss must not throw on a cleared timer.
    vi.advanceTimersByTime(6_000);
    expect(toasts.items).toHaveLength(0);
  });
});
