/**
 * FRI-142 (ADR-048): the home-screen app-icon badge driver (open-app case).
 *
 * While the PWA is foregrounded the dashboard owns the badge: it mirrors the
 * open attention-worthy `inbox_items` count (`inbox.attentionCount`) onto the
 * app icon via `navigator.setAppBadge(count)`, and clears it with
 * `navigator.clearAppBadge()` at zero. For the CLOSED-app case the daemon
 * stamps the SAME count (`computeBadgeCount()`) into each push payload and the
 * service worker sets it from its `push` handler — so the badge is consistent
 * whether or not the app is running. This module is the open-app half.
 *
 * Platform boundary (iOS 16.4+): `setAppBadge` only renders for a home-screen-
 * installed PWA with notification permission granted; in a plain Safari tab the
 * call is a silent no-op. We feature-detect (`'setAppBadge' in navigator`) and
 * degrade silently — never throw — so non-installed tabs are unaffected. The
 * Badging API is exposed in Worker contexts too, which is why the SW can set it
 * while the app is closed; here we only ever run on the window.
 *
 * Idempotency: we track the last value pushed to the OS and skip redundant
 * calls, so a reactive `$effect` re-running on unrelated inbox churn doesn't
 * spam `setAppBadge` with the same number.
 */

/** Whether this browser exposes the Badging API at all. */
export function appBadgeSupported(): boolean {
  return typeof navigator !== "undefined" && "setAppBadge" in navigator;
}

/** The last count we successfully handed to the OS — guards redundant calls. */
let lastApplied: number | null = null;

/**
 * Reflect `count` onto the home-screen app icon. `0` (or negative) clears the
 * badge; a positive count sets the numeric pip. No-op when the Badging API is
 * absent (plain tab) or when `count` already matches the last applied value.
 * Never throws — a rejected promise (permission revoked mid-session) is
 * swallowed; the next change re-attempts.
 */
export function setAppBadgeCount(count: number): void {
  if (!appBadgeSupported()) return;
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n === lastApplied) return;
  lastApplied = n;
  const nav = navigator as Navigator & {
    setAppBadge?: (contents?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  if (n === 0) {
    void nav.clearAppBadge?.().catch(() => {});
  } else {
    void nav.setAppBadge?.(n).catch(() => {});
  }
}

/** Test-only: reset the dedup guard between specs. */
export function __resetAppBadgeForTest(): void {
  lastApplied = null;
}
