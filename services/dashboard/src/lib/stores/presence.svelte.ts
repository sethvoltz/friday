/**
 * FRI-142 (ADR-048): client presence heartbeat.
 *
 * Reports this client's foreground/background state to the daemon so the
 * Notification router can choose Toast (present) over Push (away). The daemon
 * keeps an in-memory `Map<deviceId, { lastSeen, visible }>` (TTL ~45s),
 * OR-aggregated per user — so a single device going quiet does not mark the
 * user away as long as another device is live.
 *
 * Cadence (BLOCKED-ON-OWNER default (a): 20s keepalive / 45s TTL):
 *   - A `visibilitychange` fires an immediate report (the edge the router most
 *     cares about — present↔away).
 *   - While visible, a 20s keepalive re-asserts presence so the daemon's 45s
 *     TTL never lapses on an idle-but-foregrounded tab (one missed beat is
 *     tolerated; two are not).
 *   - When hidden we send ONE `visible:false` report then stop the keepalive —
 *     no point heartbeating "away"; the TTL expiring says the same thing, and
 *     the explicit false makes the away transition immediate rather than
 *     TTL-delayed.
 *
 * The IO boundary is `fetch('/api/presence')` + `document.visibilityState`.
 * Observable state is the POSTs themselves (no store state — presence lives in
 * the daemon). `deviceId` is the `friday-device-id` value the caller passes
 * (`zeroSync.currentDeviceId`); the heartbeat is inert until it's known.
 */

import type { PresenceReport } from "@friday/shared";

/** BLOCKED-ON-OWNER default (a): 20s keepalive (TTL is 45s, daemon-side). */
const KEEPALIVE_MS = 20_000;

let started = false;
let deviceId: string | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let visListener: (() => void) | null = null;

function isVisible(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible";
}

/** Fire-and-forget POST of the current presence verdict. Swallows errors —
 *  a missed beat is recovered by the next one (or the daemon's TTL fail-safe). */
function report(visible: boolean): void {
  if (!deviceId) return;
  const body: PresenceReport = { deviceId, visible };
  void fetch("/api/presence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true, // survive a page-hide so the `visible:false` lands
  }).catch(() => {
    // Best-effort — presence is fail-safe (stale ⇒ away ⇒ push).
  });
}

function startKeepalive(): void {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    if (isVisible()) report(true);
  }, KEEPALIVE_MS);
}

function stopKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function onVisibilityChange(): void {
  if (isVisible()) {
    report(true);
    startKeepalive();
  } else {
    // Send one explicit "away" so the transition is immediate, then stop
    // heartbeating — no point re-asserting "away" every 20s.
    report(false);
    stopKeepalive();
  }
}

/**
 * Begin reporting presence for `id` (the device id). Sends an immediate report
 * for the current visibility, arms the keepalive if visible, and wires the
 * `visibilitychange` listener. Idempotent — a second call only updates the
 * device id (e.g. once `/api/sync/refresh` resolves it after mount).
 *
 * Call from the root layout's `onMount` once `zeroSync.currentDeviceId` is set.
 */
export function startPresence(id: string): void {
  deviceId = id;
  if (started) {
    // Device id arrived/changed after start — re-assert immediately.
    if (isVisible()) report(true);
    return;
  }
  started = true;
  if (typeof document !== "undefined") {
    visListener = onVisibilityChange;
    document.addEventListener("visibilitychange", visListener);
  }
  // Initial report for the current state.
  if (isVisible()) {
    report(true);
    startKeepalive();
  } else {
    report(false);
  }
}

export function stopPresence(): void {
  if (!started) return;
  started = false;
  stopKeepalive();
  if (visListener && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", visListener);
    visListener = null;
  }
  // Final "away" so the daemon doesn't carry stale presence past unmount.
  report(false);
  deviceId = null;
}

/** Test-only: reset module state between specs. */
export function __resetForTest(): void {
  stopKeepalive();
  if (visListener && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", visListener);
    visListener = null;
  }
  started = false;
  deviceId = null;
}
