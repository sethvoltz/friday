/**
 * Screen wake lock for mobile chat (FRI-87).
 *
 * Holds a `WakeLockSentinel` whenever any agent in `chat.agents` is in the
 * `working` state and the user has the feature enabled. Releases as soon as
 * every agent returns to idle.
 *
 * Platform caveats:
 *   - Feature-detect `navigator.wakeLock` — desktop Firefox lacks it. Fail
 *     silently; this is best-effort UX, not a correctness requirement.
 *   - iOS Safari only honours the lock when the page is foreground and the
 *     screen is already on. It will NOT wake a locked phone. Documented so
 *     a future reader doesn't try to "fix" it.
 *   - The platform auto-releases the lock when the document goes hidden, so
 *     `visibilitychange` is the trigger to re-acquire on return.
 *   - The lock auto-releases when the `WakeLockSentinel` is garbage
 *     collected; we retain a module-level ref so it stays alive as long as
 *     we intend to hold it.
 */

import { chat } from "./chat.svelte";
import { loadJSON, saveJSON } from "./persistent";

const SETTINGS_KEY = "settings:wakeLock";

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
  removeEventListener(type: "release", listener: () => void): void;
}

interface WakeLockApi {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

function getWakeLockApi(): WakeLockApi | null {
  if (typeof navigator === "undefined") return null;
  const api = (navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock;
  return api ?? null;
}

function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia("(max-width: 768px)").matches;
  } catch {
    return false;
  }
}

class WakeLockSettings {
  /** User preference. Mobile defaults on, desktop defaults off. */
  enabled = $state<boolean>(false);
  private hydrated = false;

  hydrate(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    const stored = loadJSON<boolean | null>(SETTINGS_KEY, null);
    if (stored === null) {
      this.enabled = isMobileViewport();
    } else {
      this.enabled = stored;
    }
  }

  set(value: boolean): void {
    this.enabled = value;
    saveJSON(SETTINGS_KEY, value);
  }
}

export const wakeLockSettings = new WakeLockSettings();

class WakeLockState {
  /** True while we currently hold a live sentinel. Drives the UI indicator. */
  held = $state(false);
  /**
   * True if the browser exposes the API at all. Detected at module load
   * — `getWakeLockApi()` is SSR-safe via its `typeof navigator` guard,
   * and reading on the server gives `false`, which is fine because the
   * settings card only matters once hydration runs in the browser.
   * Doing this eagerly avoids the disabled-toggle + unsupported-message
   * flash on supported browsers before layout's `onMount` fires.
   */
  supported = $state(getWakeLockApi() !== null);
}

export const wakeLockState = new WakeLockState();

let sentinel: WakeLockSentinelLike | null = null;
let acquiring = false;
let visListener: (() => void) | null = null;
let started = false;
let stopEffect: (() => void) | null = null;

function anyAgentWorking(): boolean {
  for (const a of chat.agents) {
    if (a.status === "working") return true;
  }
  return false;
}

async function acquire(): Promise<void> {
  if (sentinel && !sentinel.released) return;
  if (acquiring) return;
  const api = getWakeLockApi();
  if (!api) return;
  if (typeof document !== "undefined" && document.visibilityState !== "visible") {
    // The platform refuses requests when hidden. We'll retry on
    // `visibilitychange`.
    return;
  }
  acquiring = true;
  try {
    const s = await api.request("screen");
    // Re-check intent after the await — the user may have toggled the
    // setting off, or every agent may have returned to idle, while the
    // request was in flight. Without this, we'd silently hold a lock we
    // had explicitly decided to drop.
    if (!shouldHold()) {
      try {
        await s.release();
      } catch {
        // ignore — best-effort
      }
      return;
    }
    sentinel = s;
    wakeLockState.held = true;
    const onRelease = () => {
      if (sentinel === s) {
        sentinel = null;
        wakeLockState.held = false;
      }
      s.removeEventListener("release", onRelease);
    };
    s.addEventListener("release", onRelease);
  } catch {
    // Common path: page hidden, permission denied, or unsupported context.
    // No-op — `held` stays false and the next visibility/state change will
    // give us another shot.
  } finally {
    acquiring = false;
  }
}

async function release(): Promise<void> {
  const s = sentinel;
  sentinel = null;
  wakeLockState.held = false;
  if (!s || s.released) return;
  try {
    await s.release();
  } catch {
    // ignore — best-effort
  }
}

function shouldHold(): boolean {
  return wakeLockSettings.enabled && anyAgentWorking();
}

function reconcile(): void {
  if (shouldHold()) {
    void acquire();
  } else if (sentinel) {
    void release();
  }
}

/**
 * Mount the reactive bridge: watch chat.agents + settings, request/release
 * accordingly, and re-acquire on `visibilitychange`. Safe to call multiple
 * times — subsequent calls are no-ops.
 *
 * Must be called from inside a Svelte component effect context (e.g.
 * onMount in the root layout) because it uses `$effect.root` for the
 * reactive subscription.
 */
export function startWakeLock(): void {
  if (started) return;
  started = true;
  wakeLockSettings.hydrate();
  wakeLockState.supported = getWakeLockApi() !== null;
  if (!wakeLockState.supported) return;

  stopEffect = $effect.root(() => {
    // `reconcile()` calls `shouldHold()` which reads `wakeLockSettings.enabled`
    // and iterates `chat.agents` — establishing subscriptions on both. The
    // effect re-runs whenever either changes.
    $effect(reconcile);
  });

  if (typeof document !== "undefined") {
    visListener = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    document.addEventListener("visibilitychange", visListener);
  }
}

export function stopWakeLock(): void {
  if (!started) return;
  started = false;
  if (stopEffect) {
    stopEffect();
    stopEffect = null;
  }
  if (visListener && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", visListener);
    visListener = null;
  }
  void release();
}

/** Test-only: drive a reconcile pass without standing up the layout. */
export function __reconcileForTest(): void {
  reconcile();
}

/** Test-only: reset module state between specs. */
export function __resetForTest(): void {
  if (stopEffect) {
    stopEffect();
    stopEffect = null;
  }
  if (visListener && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", visListener);
    visListener = null;
  }
  sentinel = null;
  acquiring = false;
  started = false;
  wakeLockState.held = false;
  // Re-derive supported from whatever the test installed on navigator
  // since module load.
  wakeLockState.supported = getWakeLockApi() !== null;
}
