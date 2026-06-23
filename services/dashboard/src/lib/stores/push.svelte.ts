/**
 * FRI-142 (ADR-048): Web Push subscribe flow (client side).
 *
 * Drives the browser's Push Subscription handshake and registers the result
 * with the daemon (via the session-gated `/api/push/subscribe` proxy). The
 * daemon owns the VAPID private key + the server-only `push_subscriptions`
 * table; this module only ever sees the PUBLIC key and the browser-minted
 * subscription (`endpoint` + `p256dh`/`auth` keys).
 *
 * Platform constraints baked in here (iOS 16.4+ installed PWA — the only place
 * Web Push works on Apple devices):
 *   - `Notification.requestPermission()` + `pushManager.subscribe(...)` MUST run
 *     inside a user gesture (iOS rejects permission prompts outside one). So
 *     `subscribeToPush()` is called from a button tap, never on mount.
 *   - `userVisibleOnly: true` is mandatory on WebKit — a silent push is a
 *     promise violation and revokes the subscription. We always pass it.
 *   - Feature-detect `serviceWorker` / `PushManager` / `Notification` and
 *     degrade silently in a plain tab (no install) — none of these exist there.
 *
 * Network/IO boundary is `fetch` + `navigator.serviceWorker` + `Notification`;
 * the store's observable state is `pushState.{supported,permission,subscribed}`.
 */

import type { PushSubscribePayload } from "@friday/shared";

class PushState {
  /** Whether this browser exposes the Web Push primitives at all. */
  supported = $state(false);
  /** Mirrors `Notification.permission` ('default' | 'granted' | 'denied'). */
  permission = $state<NotificationPermission>("default");
  /** True once we hold a live `PushSubscription` registered with the daemon. */
  subscribed = $state(false);
  /** Last error message from a failed subscribe attempt (for the UI). */
  error = $state<string | null>(null);
}

export const pushState = new PushState();

function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Decode a URL-safe base64 VAPID public key to the `Uint8Array`
 * `pushManager.subscribe` wants as `applicationServerKey`. Web Push VAPID keys
 * are base64url (no padding, `-`/`_` for `+`/`/`); restore standard base64
 * before `atob`.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  // Construct on a concrete ArrayBuffer (not the default ArrayBufferLike) so
  // the result satisfies `applicationServerKey: BufferSource` — TS's DOM lib
  // rejects `Uint8Array<ArrayBufferLike>` there (the SharedArrayBuffer arm).
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Reconcile observable state from the live browser surfaces, without
 * requesting permission. Safe to call on mount (no gesture needed) — it only
 * READS `Notification.permission` and the existing subscription.
 */
export async function refreshPushState(): Promise<void> {
  pushState.supported = pushSupported();
  if (!pushState.supported) {
    pushState.subscribed = false;
    return;
  }
  pushState.permission = Notification.permission;
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    pushState.subscribed = existing !== null;
  } catch {
    pushState.subscribed = false;
  }
}

/**
 * The user-gesture subscribe flow: request permission, fetch the VAPID public
 * key, subscribe via the service worker's PushManager, and POST the resulting
 * `PushSubscribePayload` to the daemon. Returns true on success.
 *
 * MUST be invoked from a click/tap handler (iOS gesture requirement). `deviceId`
 * is the `friday-device-id` value (the caller passes `zeroSync.currentDeviceId`).
 */
export async function subscribeToPush(deviceId: string): Promise<boolean> {
  pushState.error = null;
  if (!pushSupported()) {
    pushState.supported = false;
    pushState.error = "push-unsupported";
    return false;
  }
  pushState.supported = true;

  // 1. Permission — inside the gesture. A denial is terminal until the user
  //    clears it in browser settings; surface it and stop.
  const permission = await Notification.requestPermission();
  pushState.permission = permission;
  if (permission !== "granted") {
    pushState.error = "permission-denied";
    return false;
  }

  // 2. VAPID public key from the daemon (only the public half is ever served).
  const keyRes = await fetch("/api/push/vapid-public-key");
  if (!keyRes.ok) {
    pushState.error = "vapid-key-unavailable";
    return false;
  }
  const { publicKey } = (await keyRes.json()) as { publicKey: string };
  if (!publicKey) {
    pushState.error = "vapid-key-unavailable";
    return false;
  }

  // 3. Subscribe via the SW's PushManager. `userVisibleOnly: true` is mandatory
  //    on WebKit (a silent push violates the promise and revokes the sub).
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  // 4. Register with the daemon. `toJSON()` yields `{ endpoint, keys:{p256dh,
  //    auth} }`; add the device id for the FK + revoke-cascade.
  const json = sub.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  const payload: PushSubscribePayload = {
    endpoint: json.endpoint ?? sub.endpoint,
    keys: {
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? "",
    },
    deviceId,
  };
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    pushState.error = "subscribe-register-failed";
    return false;
  }
  pushState.subscribed = true;
  return true;
}
