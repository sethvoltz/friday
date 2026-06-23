/**
 * FRI-142 (ADR-048) — push subscribe-flow client logic.
 *
 * Stateful test: the network/IO boundary (`fetch`, `Notification`,
 * `navigator.serviceWorker` + `pushManager`) is mocked; the store's reactive
 * state stays real. We assert the OBSERVABLE outcome of `subscribeToPush`:
 *   - the exact `PushSubscribePayload` POSTed to `/api/push/subscribe` (endpoint
 *     + keys + the supplied deviceId);
 *   - the VAPID public key is fetched and converted to the right bytes and
 *     handed to `pushManager.subscribe` with `userVisibleOnly: true`;
 *   - permission-denied and unsupported branches return false and never POST.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushState, subscribeToPush, refreshPushState, urlBase64ToUint8Array } from "./push.svelte";

// A real VAPID-shaped URL-safe base64 public key (87 chars, the generateVAPIDKeys
// output length). Its exact decoded byte length (65) is what we assert reaches
// pushManager.subscribe as applicationServerKey.
const VAPID_PUBLIC =
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBO47-NhrwzqJhKvCMbBNCJ-w";

const SUBSCRIPTION_JSON = {
  endpoint: "https://web.push.apple.com/sub-xyz",
  keys: { p256dh: "p256dh-value", auth: "auth-value" },
};

let permissionResult: NotificationPermission;
let subscribeSpy: ReturnType<typeof vi.fn>;
let getSubscriptionSpy: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;
let requestPermissionSpy: ReturnType<typeof vi.fn>;

function installBrowserMocks(opts: { vapidOk?: boolean; subscribeOk?: boolean } = {}): void {
  const { vapidOk = true, subscribeOk = true } = opts;

  requestPermissionSpy = vi.fn(async () => permissionResult);
  // Notification is both a value (permission) and a callable in the DOM; the
  // flow reads `.permission` and calls `.requestPermission()`. It lives on the
  // global AND must be `in window` for the feature-detect.
  const notification = {
    permission: "default" as NotificationPermission,
    requestPermission: requestPermissionSpy,
  };
  vi.stubGlobal("Notification", notification);

  const subscription = {
    endpoint: SUBSCRIPTION_JSON.endpoint,
    toJSON: () => SUBSCRIPTION_JSON,
  };
  subscribeSpy = vi.fn(async () => subscription);
  getSubscriptionSpy = vi.fn(async () => null);
  const registration = {
    pushManager: { subscribe: subscribeSpy, getSubscription: getSubscriptionSpy },
  };
  vi.stubGlobal("navigator", {
    serviceWorker: { ready: Promise.resolve(registration) },
  });
  // The feature-detect gate reads `PushManager`, `Notification`, and
  // `serviceWorker` — all three must be present.
  vi.stubGlobal("window", { PushManager: function () {}, Notification: notification });

  fetchSpy = vi.fn(async (url: string) => {
    if (url === "/api/push/vapid-public-key") {
      return vapidOk
        ? new Response(JSON.stringify({ publicKey: VAPID_PUBLIC }), { status: 200 })
        : new Response("no key", { status: 500 });
    }
    if (url === "/api/push/subscribe") {
      return subscribeOk
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response("bad", { status: 502 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
}

describe("urlBase64ToUint8Array", () => {
  it("decodes a URL-safe base64 VAPID key to the correct byte length", () => {
    const bytes = urlBase64ToUint8Array(VAPID_PUBLIC);
    // A P-256 uncompressed public key is 65 bytes (0x04 prefix + 32 + 32).
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
  });

  it("restores base64url chars (- _) before decoding", () => {
    // "-_" → "+/"; "Pw" decodes to 0x3f. Pinning a known byte proves the
    // url-safe substitution, not just that it doesn't throw.
    const bytes = urlBase64ToUint8Array("Pw");
    expect(bytes.length).toBe(1);
    expect(bytes[0]).toBe(0x3f);
  });
});

describe("subscribeToPush — gesture-driven subscribe flow", () => {
  beforeEach(() => {
    permissionResult = "granted";
    pushState.subscribed = false;
    pushState.error = null;
    pushState.permission = "default";
  });

  afterEach(() => vi.unstubAllGlobals());

  it("requests permission, fetches the VAPID key, subscribes, and POSTs the exact payload", async () => {
    installBrowserMocks();
    const ok = await subscribeToPush("device-99");

    expect(ok).toBe(true);
    expect(pushState.subscribed).toBe(true);
    expect(pushState.permission).toBe("granted");

    // Permission requested exactly once (inside the gesture).
    expect(requestPermissionSpy).toHaveBeenCalledOnce();

    // pushManager.subscribe got userVisibleOnly + the decoded key.
    expect(subscribeSpy).toHaveBeenCalledOnce();
    const subArg = subscribeSpy.mock.calls[0][0] as {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array;
    };
    expect(subArg.userVisibleOnly).toBe(true);
    expect(subArg.applicationServerKey).toEqual(urlBase64ToUint8Array(VAPID_PUBLIC));

    // The exact PushSubscribePayload reached the daemon proxy.
    const subscribeCall = fetchSpy.mock.calls.find((c) => c[0] === "/api/push/subscribe")!;
    const body = JSON.parse((subscribeCall[1] as RequestInit).body as string);
    expect(body).toEqual({
      endpoint: SUBSCRIPTION_JSON.endpoint,
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
      deviceId: "device-99",
    });
  });

  it("returns false and never POSTs when permission is denied", async () => {
    installBrowserMocks();
    permissionResult = "denied";
    const ok = await subscribeToPush("device-99");

    expect(ok).toBe(false);
    expect(pushState.subscribed).toBe(false);
    expect(pushState.error).toBe("permission-denied");
    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.some((c) => c[0] === "/api/push/subscribe")).toBe(false);
  });

  it("returns false when the VAPID key is unavailable and never subscribes", async () => {
    installBrowserMocks({ vapidOk: false });
    const ok = await subscribeToPush("device-99");

    expect(ok).toBe(false);
    expect(pushState.error).toBe("vapid-key-unavailable");
    expect(subscribeSpy).not.toHaveBeenCalled();
  });

  it("surfaces a register failure when the daemon proxy rejects the subscription", async () => {
    installBrowserMocks({ subscribeOk: false });
    const ok = await subscribeToPush("device-99");

    expect(ok).toBe(false);
    expect(pushState.subscribed).toBe(false);
    expect(pushState.error).toBe("subscribe-register-failed");
    // It DID subscribe in the browser — the failure is at registration.
    expect(subscribeSpy).toHaveBeenCalledOnce();
  });

  it("is unsupported (returns false, no fetch) when PushManager is absent", async () => {
    // No browser mocks installed → pushSupported() is false.
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    const fetchNever = vi.fn();
    vi.stubGlobal("fetch", fetchNever);

    const ok = await subscribeToPush("device-99");
    expect(ok).toBe(false);
    expect(pushState.supported).toBe(false);
    expect(pushState.error).toBe("push-unsupported");
    expect(fetchNever).not.toHaveBeenCalled();
  });
});

describe("refreshPushState — read-only reconcile (no permission prompt)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports subscribed=true when a live subscription already exists", async () => {
    installBrowserMocks();
    getSubscriptionSpy.mockResolvedValueOnce({ endpoint: "x" });
    pushState.subscribed = false;

    await refreshPushState();

    expect(pushState.supported).toBe(true);
    expect(pushState.subscribed).toBe(true);
    // A read-only reconcile must NOT prompt for permission.
    expect(requestPermissionSpy).not.toHaveBeenCalled();
  });

  it("reports subscribed=false when there is no existing subscription", async () => {
    installBrowserMocks();
    pushState.subscribed = true;
    await refreshPushState();
    expect(pushState.subscribed).toBe(false);
  });
});
