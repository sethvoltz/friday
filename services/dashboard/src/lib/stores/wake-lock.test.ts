// @vitest-environment jsdom
/**
 * Wake-lock store tests (FRI-87).
 *
 * Tests the state machine where it lives: agents going idle→working must
 * acquire a sentinel; working→idle must release it; visibilitychange while
 * agents are working must re-acquire after the platform auto-release.
 *
 * Stubs the `navigator.wakeLock` boundary so we can drive both the
 * `release` event (platform auto-released on tab hide) and the
 * acquire/release call counts. Leaves the Svelte reactive layer real —
 * `$state` arrays on `chat.agents` mutate live.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, tick } from "svelte";

async function flushReactive() {
  flushSync();
  await tick();
  await Promise.resolve();
  await Promise.resolve();
}

const mockLoadJSON = vi.fn();
const mockSaveJSON = vi.fn();
vi.mock("$lib/stores/persistent", () => ({
  loadJSON: mockLoadJSON,
  saveJSON: mockSaveJSON,
  KEYS: { transcript: (agent: string) => `transcript:${agent}` },
}));

interface FakeSentinel {
  released: boolean;
  release: ReturnType<typeof vi.fn>;
  addEventListener: (type: "release", listener: () => void) => void;
  removeEventListener: (type: "release", listener: () => void) => void;
  fireRelease: () => void;
}

function makeFakeSentinel(): FakeSentinel {
  const listeners = new Set<() => void>();
  const s: FakeSentinel = {
    released: false,
    release: vi.fn(async () => {
      s.released = true;
      for (const fn of listeners) fn();
    }),
    addEventListener: (_t, l) => {
      listeners.add(l);
    },
    removeEventListener: (_t, l) => {
      listeners.delete(l);
    },
    fireRelease: () => {
      s.released = true;
      for (const fn of listeners) fn();
    },
  };
  return s;
}

function installFakeWakeLock() {
  const sentinels: FakeSentinel[] = [];
  const request = vi.fn(async (_type: "screen") => {
    const s = makeFakeSentinel();
    sentinels.push(s);
    return s;
  });
  Object.defineProperty(navigator, "wakeLock", {
    value: { request },
    configurable: true,
  });
  // jsdom defaults to "visible"; force it so the guard inside acquire()
  // doesn't bail before the test's first reconcile.
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  return { request, sentinels };
}

function setVisibility(v: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    value: v,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  mockLoadJSON.mockReset();
  mockSaveJSON.mockReset();
  mockLoadJSON.mockReturnValue(true); // enabled by default
  vi.resetModules();
});

async function load() {
  const wl = await import("./wake-lock.svelte");
  const { chat } = await import("./chat.svelte");
  wl.__resetForTest();
  chat.agents = [];
  chat.focusedAgent = "friday";
  return { wl, chat };
}

describe("wake-lock store (FRI-87)", () => {
  it("acquires a sentinel on idle→working transition", async () => {
    const { request, sentinels } = installFakeWakeLock();
    const { wl, chat } = await load();

    wl.startWakeLock();
    chat.agents = [{ name: "friday", type: "orchestrator", status: "idle" }];
    wl.__reconcileForTest();
    expect(request).not.toHaveBeenCalled();
    expect(wl.wakeLockState.held).toBe(false);

    chat.agents = [{ name: "friday", type: "orchestrator", status: "working" }];
    wl.__reconcileForTest();
    // request is async — wait one tick.
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("screen");
    expect(sentinels).toHaveLength(1);
    expect(wl.wakeLockState.held).toBe(true);
  });

  it("releases the sentinel when all agents return to idle", async () => {
    const { sentinels } = installFakeWakeLock();
    const { wl, chat } = await load();
    wl.startWakeLock();

    chat.agents = [
      { name: "friday", type: "orchestrator", status: "working" },
      { name: "builder-a", type: "builder", status: "working" },
    ];
    wl.__reconcileForTest();
    await Promise.resolve();
    await Promise.resolve();
    expect(wl.wakeLockState.held).toBe(true);
    expect(sentinels).toHaveLength(1);

    // One goes idle — still holding.
    chat.agents = [
      { name: "friday", type: "orchestrator", status: "working" },
      { name: "builder-a", type: "builder", status: "idle" },
    ];
    wl.__reconcileForTest();
    await Promise.resolve();
    expect(sentinels[0].release).not.toHaveBeenCalled();
    expect(wl.wakeLockState.held).toBe(true);

    // All idle — release fires, indicator clears.
    chat.agents = [
      { name: "friday", type: "orchestrator", status: "idle" },
      { name: "builder-a", type: "builder", status: "idle" },
    ];
    wl.__reconcileForTest();
    await Promise.resolve();
    expect(sentinels[0].release).toHaveBeenCalledTimes(1);
    expect(wl.wakeLockState.held).toBe(false);
  });

  it("re-acquires after the platform auto-releases on tab hide and the tab returns to visible", async () => {
    const { request, sentinels } = installFakeWakeLock();
    const { wl, chat } = await load();
    wl.startWakeLock();

    chat.agents = [{ name: "friday", type: "orchestrator", status: "working" }];
    wl.__reconcileForTest();
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(wl.wakeLockState.held).toBe(true);

    // Simulate the platform auto-release (tab hidden). The sentinel's
    // `release` event fires without us calling .release().
    sentinels[0].fireRelease();
    expect(wl.wakeLockState.held).toBe(false);

    // Tab returns to visible — listener should re-acquire because the
    // agent is still working.
    setVisibility("visible");
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    expect(sentinels).toHaveLength(2);
    expect(wl.wakeLockState.held).toBe(true);
  });

  it("does not request when disabled in settings", async () => {
    mockLoadJSON.mockReturnValue(false);
    const { request } = installFakeWakeLock();
    const { wl, chat } = await load();
    wl.startWakeLock();

    chat.agents = [{ name: "friday", type: "orchestrator", status: "working" }];
    wl.__reconcileForTest();
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    expect(wl.wakeLockState.held).toBe(false);
  });

  it("releases when the user toggles the setting off while an agent is working", async () => {
    const { sentinels } = installFakeWakeLock();
    const { wl, chat } = await load();
    wl.startWakeLock();

    chat.agents = [{ name: "friday", type: "orchestrator", status: "working" }];
    wl.__reconcileForTest();
    await Promise.resolve();
    await Promise.resolve();
    expect(wl.wakeLockState.held).toBe(true);

    wl.wakeLockSettings.set(false);
    wl.__reconcileForTest();
    await Promise.resolve();
    expect(sentinels[0].release).toHaveBeenCalledTimes(1);
    expect(wl.wakeLockState.held).toBe(false);
    expect(mockSaveJSON).toHaveBeenCalledWith("settings:wakeLock", false);
  });

  describe("reactive bridge (no manual reconcile)", () => {
    it("acquires when chat.agents is replaced with a working agent — driven only by $effect", async () => {
      const { request } = installFakeWakeLock();
      const { wl, chat } = await load();
      wl.startWakeLock();
      await flushReactive();

      chat.agents = [{ name: "friday", type: "orchestrator", status: "working" }];
      await flushReactive();
      await Promise.resolve();
      await Promise.resolve();

      expect(request).toHaveBeenCalledTimes(1);
      expect(wl.wakeLockState.held).toBe(true);
    });

    it("acquires when an agent's status field flips via index-element replacement", async () => {
      const { request } = installFakeWakeLock();
      const { wl, chat } = await load();
      wl.startWakeLock();

      chat.agents = [{ name: "friday", type: "orchestrator", status: "idle" }];
      await flushReactive();
      expect(request).not.toHaveBeenCalled();

      // Replace the element in place — the production code path. If the
      // $effect subscribes only to the array identity and not to element
      // status changes, this is where it would silently fail.
      chat.agents[0] = {
        ...chat.agents[0],
        status: "working",
      };
      await flushReactive();

      expect(request).toHaveBeenCalledTimes(1);
      expect(wl.wakeLockState.held).toBe(true);
    });

    it("releases when the last working agent's status field flips to idle in place", async () => {
      const { sentinels } = installFakeWakeLock();
      const { wl, chat } = await load();
      wl.startWakeLock();
      await flushReactive();

      chat.agents = [{ name: "friday", type: "orchestrator", status: "working" }];
      await flushReactive();
      await Promise.resolve();
      await Promise.resolve();
      expect(wl.wakeLockState.held).toBe(true);

      chat.agents[0] = { ...chat.agents[0], status: "idle" };
      await flushReactive();

      expect(sentinels[0].release).toHaveBeenCalledTimes(1);
      expect(wl.wakeLockState.held).toBe(false);
    });
  });

  it("releases the sentinel if all agents go idle while the request is in flight (race)", async () => {
    // Drive a deferred request resolution so we can mutate state between
    // request() and its resolution — the exact window where blocker #1
    // could leak a sentinel.
    let resolveRequest: ((s: FakeSentinel) => void) | null = null;
    const sentinels: FakeSentinel[] = [];
    const request = vi.fn(
      () =>
        new Promise<FakeSentinel>((res) => {
          resolveRequest = (s) => {
            sentinels.push(s);
            res(s);
          };
        }),
    );
    Object.defineProperty(navigator, "wakeLock", {
      value: { request },
      configurable: true,
    });
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    const { wl, chat } = await load();
    wl.startWakeLock();

    chat.agents = [{ name: "friday", type: "orchestrator", status: "working" }];
    wl.__reconcileForTest();
    // request() has been called and is pending.
    expect(request).toHaveBeenCalledTimes(1);
    expect(resolveRequest).not.toBeNull();

    // All agents go idle BEFORE the sentinel resolves. shouldHold() now
    // returns false; if the in-flight acquire blindly assigns sentinel
    // we'd leak the lock.
    chat.agents = [{ name: "friday", type: "orchestrator", status: "idle" }];

    // Now resolve the request — sentinel arrives.
    const s = makeFakeSentinel();
    resolveRequest!(s);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The post-await intent re-check must release it and leave us empty-
    // handed.
    expect(sentinels).toHaveLength(1);
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(wl.wakeLockState.held).toBe(false);
  });

  it("reconcileWakeLock() is the deterministic wire from zero.svelte.ts and acquires without relying on $effect propagation", async () => {
    // This is the contract that fixes the prod regression where the
    // lock silently never acquired on mobile despite the setting being
    // on. zero.svelte.ts's #bindAgents listener calls reconcileWakeLock()
    // explicitly after every agents-view update — bypassing the
    // $effect.root path that turned out to be flaky across the Zero
    // listener callback / Svelte effect-scheduling seam in practice.
    const { request, sentinels } = installFakeWakeLock();
    const { wl, chat } = await load();
    wl.startWakeLock();

    // Mutate chat.agents the way zero.svelte.ts's listener does, but
    // do NOT call __reconcileForTest. Only the explicit reconcile
    // hook fires. If the deterministic wire is correct, the lock
    // still acquires.
    chat.agents = [{ name: "friday", type: "orchestrator", status: "working" }];
    wl.reconcileWakeLock();
    await flushReactive();

    expect(request).toHaveBeenCalledTimes(1);
    expect(sentinels).toHaveLength(1);
    expect(wl.wakeLockState.held).toBe(true);
  });

  it("reconcileWakeLock() is a no-op before startWakeLock() (pre-mount callers must not crash or acquire)", async () => {
    const { request } = installFakeWakeLock();
    const { wl, chat } = await load();
    // No startWakeLock() — simulating a pre-mount Zero update.
    chat.agents = [{ name: "friday", type: "orchestrator", status: "working" }];
    expect(() => wl.reconcileWakeLock()).not.toThrow();
    await flushReactive();
    expect(request).not.toHaveBeenCalled();
    expect(wl.wakeLockState.held).toBe(false);
  });

  it("reconcileWakeLock() releases when agents transition back to idle", async () => {
    const { sentinels } = installFakeWakeLock();
    const { wl, chat } = await load();
    wl.startWakeLock();

    chat.agents = [{ name: "friday", type: "orchestrator", status: "working" }];
    wl.reconcileWakeLock();
    await flushReactive();
    expect(sentinels).toHaveLength(1);
    expect(wl.wakeLockState.held).toBe(true);

    chat.agents = [{ name: "friday", type: "orchestrator", status: "idle" }];
    wl.reconcileWakeLock();
    await flushReactive();
    expect(sentinels[0].release).toHaveBeenCalledTimes(1);
    expect(wl.wakeLockState.held).toBe(false);
  });

  describe("focus-aware lock (only front agent triggers hold)", () => {
    it("does not acquire when a background agent is working but the focused agent is idle", async () => {
      const { request } = installFakeWakeLock();
      const { wl, chat } = await load();

      wl.startWakeLock();
      chat.agents = [
        { name: "friday", type: "orchestrator", status: "idle" },
        { name: "builder-foo", type: "builder", status: "working" },
      ];
      // friday is focused (default); builder-foo is working but not front
      wl.__reconcileForTest();
      await flushReactive();

      expect(request).not.toHaveBeenCalled();
      expect(wl.wakeLockState.held).toBe(false);
    });

    it("acquires when the user switches focus to a working agent", async () => {
      const { request, sentinels } = installFakeWakeLock();
      const { wl, chat } = await load();

      wl.startWakeLock();
      chat.agents = [
        { name: "friday", type: "orchestrator", status: "idle" },
        { name: "builder-foo", type: "builder", status: "working" },
      ];
      wl.__reconcileForTest();
      await flushReactive();
      expect(request).not.toHaveBeenCalled();

      // User taps builder-foo in the sidebar — focus switches
      chat.focusedAgent = "builder-foo";
      wl.__reconcileForTest();
      await flushReactive();

      expect(request).toHaveBeenCalledTimes(1);
      expect(sentinels).toHaveLength(1);
      expect(wl.wakeLockState.held).toBe(true);
    });

    it("releases when the user switches focus away from the working agent", async () => {
      const { sentinels } = installFakeWakeLock();
      const { wl, chat } = await load();

      wl.startWakeLock();
      chat.agents = [
        { name: "friday", type: "orchestrator", status: "idle" },
        { name: "builder-foo", type: "builder", status: "working" },
      ];
      chat.focusedAgent = "builder-foo";
      wl.__reconcileForTest();
      await flushReactive();
      expect(wl.wakeLockState.held).toBe(true);

      // User switches back to friday (which is idle)
      chat.focusedAgent = "friday";
      wl.__reconcileForTest();
      await flushReactive();

      expect(sentinels[0].release).toHaveBeenCalledTimes(1);
      expect(wl.wakeLockState.held).toBe(false);
    });
  });

  it("marks itself unsupported when navigator.wakeLock is missing", async () => {
    // Strip the API.
    Object.defineProperty(navigator, "wakeLock", {
      value: undefined,
      configurable: true,
    });
    const { wl, chat } = await load();
    wl.startWakeLock();
    expect(wl.wakeLockState.supported).toBe(false);

    chat.agents = [{ name: "friday", type: "orchestrator", status: "working" }];
    wl.__reconcileForTest();
    await Promise.resolve();
    expect(wl.wakeLockState.held).toBe(false);
  });
});
