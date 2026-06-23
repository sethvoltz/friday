/**
 * FRI-142 (ADR-048) — presence heartbeat client logic.
 *
 * Stateful test: the IO boundary (`fetch`, `document.visibilityState` +
 * `visibilitychange`) is mocked and timers are faked; the module's real
 * lifecycle (listener wiring, keepalive interval, start/stop) runs. We assert
 * the OBSERVABLE behavior — the exact `PresenceReport` bodies POSTed to
 * `/api/presence`, the 20s keepalive cadence while visible, and that hiding
 * sends one `visible:false` then stops heartbeating.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPresence, stopPresence, __resetForTest } from "./presence.svelte";

let visibility: "visible" | "hidden";
let visListeners: Array<() => void>;
let fetchSpy: ReturnType<typeof vi.fn>;

/** All PresenceReport bodies POSTed so far, in order. */
function reports(): Array<{ deviceId: string; visible: boolean }> {
  return fetchSpy.mock.calls
    .filter((c) => c[0] === "/api/presence")
    .map((c) => JSON.parse((c[1] as RequestInit).body as string));
}

/** Drive a visibilitychange the way the browser would. */
function setVisibility(v: "visible" | "hidden"): void {
  visibility = v;
  for (const l of visListeners) l();
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  visListeners = [];
  fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (type: string, cb: () => void) => {
      if (type === "visibilitychange") visListeners.push(cb);
    },
    removeEventListener: (type: string, cb: () => void) => {
      if (type === "visibilitychange") visListeners = visListeners.filter((l) => l !== cb);
    },
  });
});

afterEach(() => {
  __resetForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("startPresence", () => {
  it("sends an immediate visible:true report on start when foregrounded", async () => {
    startPresence("dev-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(reports()).toEqual([{ deviceId: "dev-1", visible: true }]);
  });

  it("re-asserts presence every 20s while visible (keepalive cadence)", async () => {
    startPresence("dev-1");
    await vi.advanceTimersByTimeAsync(0); // initial report
    await vi.advanceTimersByTimeAsync(20_000); // +1 keepalive
    await vi.advanceTimersByTimeAsync(20_000); // +1 keepalive
    expect(reports()).toEqual([
      { deviceId: "dev-1", visible: true },
      { deviceId: "dev-1", visible: true },
      { deviceId: "dev-1", visible: true },
    ]);
  });

  it("on hide sends ONE visible:false and stops the keepalive", async () => {
    startPresence("dev-1");
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(0);
    // No further beats once hidden, even past a keepalive interval.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reports()).toEqual([
      { deviceId: "dev-1", visible: true },
      { deviceId: "dev-1", visible: false },
    ]);
  });

  it("re-arms the keepalive when the tab returns to visible", async () => {
    startPresence("dev-1");
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000); // one keepalive after re-show
    expect(reports()).toEqual([
      { deviceId: "dev-1", visible: true }, // initial
      { deviceId: "dev-1", visible: false }, // hide
      { deviceId: "dev-1", visible: true }, // re-show
      { deviceId: "dev-1", visible: true }, // keepalive
    ]);
  });

  it("starts hidden: reports visible:false and does not arm the keepalive", async () => {
    visibility = "hidden";
    startPresence("dev-1");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reports()).toEqual([{ deviceId: "dev-1", visible: false }]);
  });

  it("stopPresence sends a final visible:false and removes the listener", async () => {
    startPresence("dev-1");
    await vi.advanceTimersByTimeAsync(0);
    stopPresence();
    await vi.advanceTimersByTimeAsync(0);
    expect(reports()).toEqual([
      { deviceId: "dev-1", visible: true },
      { deviceId: "dev-1", visible: false },
    ]);
    // Listener gone: a later visibility flip produces no further reports.
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reports()).toHaveLength(2);
  });

  it("is idempotent on the device id arriving twice — re-asserts, does not double-wire", async () => {
    startPresence("dev-1");
    await vi.advanceTimersByTimeAsync(0);
    startPresence("dev-2"); // device id resolved/changed after start
    await vi.advanceTimersByTimeAsync(0);
    // One keepalive interval — a single timer (not two) re-asserts.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reports()).toEqual([
      { deviceId: "dev-1", visible: true },
      { deviceId: "dev-2", visible: true }, // re-assert on the second start
      { deviceId: "dev-2", visible: true }, // single keepalive
    ]);
  });
});
