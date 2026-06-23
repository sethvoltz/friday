/**
 * FRI-142 / ADR-048 — The stateless Notification router (`notify`).
 *
 * Tested at the router layer with the IO boundary mocked (settings read,
 * subscription user list, client-device presence, push send, eventBus) and the
 * policy/presence/DND LOGIC left REAL. The bug class this owns is the WIRING:
 * does the router feed the right (policy × presence × DND) inputs into the pure
 * resolver and then actually fire the resolved channels — toast via the eventBus
 * `toast` SSE event, push via `sendPushToUser` — and stay fire-and-forget?
 *
 * Assertions pin the OBSERVABLE effect: was a `toast` event published? was push
 * sent to the user? — not internal state. Covers AC5 (policy), AC6 (DND +
 * critical bypass on/off), AC9 (empty-presence ⇒ push), plus the toast/push
 * split by presence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyEvent, NotifyPolicy } from "@friday/shared";

// ---- Mocked IO boundary. ----------------------------------------------------
// Settings the router reads (policy + DND + bypass). A test mutates these.
let settings = {
  policy: {} as NotifyPolicy,
  dndStart: null as string | null,
  dndEnd: null as string | null,
  criticalBypassDnd: true,
};
// Which users hold a subscription, and each user's presence verdict.
let subscriptionUserIds: string[] = ["user-1"];
let presentUsers = new Set<string>();
// Per-user device sets the presence resolver maps to present/absent.
let devicesByUser: Record<string, { deviceId: string; revokedAt: number | null }[]> = {};

vi.mock("./settings.js", () => ({
  readNotifySettings: vi.fn(async () => settings),
}));

vi.mock("./push-subscriptions.js", () => ({
  listDistinctSubscriptionUserIds: vi.fn(async () => subscriptionUserIds),
}));

// `sendPushToUser` is a spy recording which users got a push.
const sendPushSpy = vi.fn<
  (userId: string, event: NotifyEvent) => Promise<{ sent: number; stale: number; error: number }>
>(async () => ({ sent: 1, stale: 0, error: 0 }));
vi.mock("./push-send.js", () => ({
  sendPushToUser: (userId: string, event: NotifyEvent) => sendPushSpy(userId, event),
}));

// Presence: the router resolves a user's device set then calls isUserPresent.
// We back it with `presentUsers` for simplicity: a user with a non-revoked
// device id in `devicesByUser` is present iff in `presentUsers`.
vi.mock("@friday/shared/services", () => ({
  listClientDevicesForUser: vi.fn(async (userId: string) => devicesByUser[userId] ?? []),
}));
vi.mock("./presence.js", () => ({
  // present iff the user's (live) device set is non-empty AND the user is in
  // `presentUsers`. The router filters revoked devices BEFORE calling this, so
  // we get the already-live ids.
  isUserPresent: vi.fn((deviceIds: string[]) => {
    // The router passes the live device ids; map back to the owning user via a
    // reverse lookup over devicesByUser.
    for (const [userId, devs] of Object.entries(devicesByUser)) {
      const live = devs.filter((d) => d.revokedAt === null).map((d) => d.deviceId);
      if (live.length === deviceIds.length && live.every((id) => deviceIds.includes(id))) {
        return presentUsers.has(userId);
      }
    }
    return false;
  }),
  // GLOBAL presence drives the broadcast toast decision: any user marked present
  // ⇒ a foregrounded client exists (models the in-memory Map having a fresh,
  // visible device).
  isAnyDevicePresent: vi.fn(() => presentUsers.size > 0),
}));

// eventBus: a spy recording published `toast` events.
const publishSpy = vi.fn();
vi.mock("../events/bus.js", () => ({
  eventBus: { publish: (e: unknown) => publishSpy(e) },
}));

vi.mock("../log.js", () => ({ logger: { log: vi.fn() } }));

import { notify } from "./notify.js";

function lastToast(): Record<string, unknown> | null {
  const calls = publishSpy.mock.calls;
  return calls.length ? (calls[calls.length - 1]![0] as Record<string, unknown>) : null;
}

beforeEach(() => {
  settings = { policy: {}, dndStart: null, dndEnd: null, criticalBypassDnd: true };
  subscriptionUserIds = ["user-1"];
  presentUsers = new Set();
  devicesByUser = { "user-1": [{ deviceId: "dev-1", revokedAt: null }] };
  sendPushSpy.mockClear();
  publishSpy.mockClear();
});
afterEach(() => vi.clearAllMocks());

const archiveEvent: NotifyEvent = {
  type: "builder_archive",
  title: "Builder finished",
  body: "ready",
  deepLink: "/agents/x",
};

describe("notify — toast vs push split by presence (defaults)", () => {
  it("PRESENT user: default builder_archive fires a TOAST and NO push", async () => {
    presentUsers = new Set(["user-1"]);
    await notify(archiveEvent);

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(lastToast()).toMatchObject({
      type: "toast",
      title: "Builder finished",
      body: "ready",
      deep_link: "/agents/x",
      event_type: "builder_archive",
    });
    expect(sendPushSpy).not.toHaveBeenCalled();
  });

  it("ABSENT user: default builder_archive fires a PUSH and NO toast (AC9 fail-safe shape)", async () => {
    presentUsers = new Set(); // nobody present ⇒ away
    await notify(archiveEvent);

    expect(sendPushSpy).toHaveBeenCalledTimes(1);
    expect(sendPushSpy).toHaveBeenCalledWith("user-1", archiveEvent);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("empty subscription set + empty presence ⇒ no push users, toast suppressed (present_only)", async () => {
    subscriptionUserIds = [];
    devicesByUser = {};
    await notify(archiveEvent);
    // No users to push; global presence empty ⇒ default toast present_only suppresses.
    expect(sendPushSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("a PRESENT client that never subscribed to push STILL gets a toast (global presence, not the sub set)", async () => {
    subscriptionUserIds = []; // never subscribed to Web Push
    devicesByUser = {};
    presentUsers = new Set(["user-1"]); // but a client is foregrounded ⇒ global present
    await notify(archiveEvent);
    // Toast fires on global presence; no push (no subscriptions).
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(lastToast()).toMatchObject({ type: "toast", event_type: "builder_archive" });
    expect(sendPushSpy).not.toHaveBeenCalled();
  });
});

describe("notify — explicit policy (AC5)", () => {
  it("mail_delivered with toast:'never'/push:'never' fires ZERO channels", async () => {
    settings.policy = { mail_delivered: { toast: "never", push: "never" } };
    presentUsers = new Set(["user-1"]); // even present, never fires
    await notify({ type: "mail_delivered", title: "Mail", body: "1 new" });
    expect(publishSpy).not.toHaveBeenCalled();
    expect(sendPushSpy).not.toHaveBeenCalled();
  });

  it("builder_archive.push:'always' fires Push EVEN when present", async () => {
    settings.policy = { builder_archive: { push: "always" } };
    presentUsers = new Set(["user-1"]);
    await notify(archiveEvent);
    expect(sendPushSpy).toHaveBeenCalledTimes(1);
  });
});

describe("notify — DND + critical bypass (AC6)", () => {
  // A DND window that always contains "now" by spanning the whole day. Crosses
  // midnight semantics aside, [00:00, 23:59) covers every minute except 23:59;
  // use a window we can guarantee contains the test clock by spanning a full
  // 24h via the midnight-crossing branch: start 00:00, end 00:00 is zero-length
  // (never). Instead pin: start one minute ahead, end one minute behind ⇒
  // crosses-midnight covers all-but-one minute. To be deterministic, freeze the
  // clock and choose a window we know contains it.
  const fixed = new Date("2026-06-22T03:00:00"); // 03:00 local

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixed);
    // 22:00 → 07:00 overnight DND window contains 03:00.
    settings.dndStart = "22:00";
    settings.dndEnd = "07:00";
    presentUsers = new Set(); // absent so push is the channel under test
  });
  afterEach(() => vi.useRealTimers());

  it("inside DND: a non-critical push is SUPPRESSED even with push:'always'", async () => {
    settings.policy = { builder_archive: { push: "always", toast: "never" } };
    await notify(archiveEvent);
    expect(sendPushSpy).not.toHaveBeenCalled();
  });

  it("inside DND: a CRITICAL event (priority:'critical') with bypass ON still pushes", async () => {
    settings.criticalBypassDnd = true;
    await notify({
      type: "mail_delivered",
      title: "Urgent",
      body: "critical mail",
      priority: "critical",
      // mail_delivered.push defaults to 'never'; override so the only thing
      // gating the push is DND + bypass, not the base rule.
    });
    // Base mail_delivered.push='never' suppresses regardless — so use a policy
    // where push would fire if not for DND.
    expect(sendPushSpy).not.toHaveBeenCalled(); // 'never' base rule still wins

    // Now with an always push rule + critical bypass:
    settings.policy = { evolve_critical: { push: "always", toast: "never" } };
    await notify({ type: "evolve_critical", title: "Crit", body: "x" });
    expect(sendPushSpy).toHaveBeenCalledTimes(1);
  });

  it("inside DND: a CRITICAL event with bypass OFF is suppressed", async () => {
    settings.criticalBypassDnd = false;
    settings.policy = { evolve_critical: { push: "always", toast: "never" } };
    await notify({ type: "evolve_critical", title: "Crit", body: "x" });
    expect(sendPushSpy).not.toHaveBeenCalled();
  });
});

describe("notify — REAL revoked-device presence filter (un-mocked presence)", () => {
  // The mocked `./presence.js` above re-implements the `revokedAt === null`
  // filter inside its fake `isUserPresent`, so the REAL revoked filter in
  // notify.ts (`resolveUserPresence` → `d.revokedAt === null`) is never
  // exercised by the other cases. This case swaps the mock out for the REAL
  // presence module so the chain resolveUserPresence → revoked-filter →
  // isUserPresent runs for real: a single REVOKED device that reports
  // `visible: true` must be EXCLUDED ⇒ the user resolves ABSENT ⇒ a default
  // `builder_archive` (push: "absent_only") STILL fires a PUSH. Deleting the
  // `d.revokedAt === null` filter from notify.ts would let the revoked device
  // count as present ⇒ user PRESENT ⇒ push wrongly SUPPRESSED ⇒ this fails.
  beforeEach(async () => {
    const realPresence = await vi.importActual<typeof import("./presence.js")>("./presence.js");
    // Point the hoisted mock's exports at the REAL implementations for this
    // block only. The router's resolveUserPresence filters revoked devices
    // BEFORE calling the real isUserPresent, so the filter is what's under test.
    const mocked = await import("./presence.js");
    vi.mocked(mocked.isUserPresent).mockImplementation(realPresence.isUserPresent);
    vi.mocked(mocked.isAnyDevicePresent).mockImplementation(realPresence.isAnyDevicePresent);
    realPresence.__resetPresenceForTest();
  });
  afterEach(async () => {
    const realPresence = await vi.importActual<typeof import("./presence.js")>("./presence.js");
    realPresence.__resetPresenceForTest();
  });

  it("a REVOKED device reporting visible:true is excluded ⇒ user ABSENT ⇒ default builder_archive PUSHES", async () => {
    const realPresence = await vi.importActual<typeof import("./presence.js")>("./presence.js");

    // User-1 owns exactly ONE device, and it is REVOKED (forgotten).
    devicesByUser = { "user-1": [{ deviceId: "dev-revoked", revokedAt: 1_700_000_000_000 }] };
    subscriptionUserIds = ["user-1"];

    // That revoked device is, in the in-memory presence Map, fresh + VISIBLE.
    // If notify.ts did NOT filter revoked devices, this would make the user
    // present and SUPPRESS the push. The filter excludes it ⇒ live set empty ⇒
    // isUserPresent([]) === false ⇒ absent ⇒ push.
    realPresence.reportPresence({ deviceId: "dev-revoked", visible: true });
    expect(realPresence.isUserPresent(["dev-revoked"])).toBe(true); // raw id IS present…

    await notify(archiveEvent);

    // …yet the user resolves ABSENT (the revoked id never reaches isUserPresent),
    // so the default `builder_archive` push (absent_only) fires.
    expect(sendPushSpy).toHaveBeenCalledTimes(1);
    expect(sendPushSpy).toHaveBeenCalledWith("user-1", archiveEvent);
    // Global presence: the only reporting device is revoked-but-visible. The
    // broadcast toast is gated on isAnyDevicePresent(), which is keyed on the
    // raw Map (not the revoked filter), so a visible device DOES drive a toast.
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(lastToast()).toMatchObject({ type: "toast", event_type: "builder_archive" });
  });
});

describe("notify — fire-and-forget (never throws)", () => {
  it("a settings read failure is swallowed (no throw into the producer)", async () => {
    const mod = await import("./settings.js");
    (mod.readNotifySettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db down"),
    );
    await expect(notify(archiveEvent)).resolves.toBeUndefined();
    expect(sendPushSpy).not.toHaveBeenCalled();
  });

  it("a push send failure is swallowed and does not abort the fan-out to other users", async () => {
    subscriptionUserIds = ["user-1", "user-2"];
    devicesByUser = {
      "user-1": [{ deviceId: "dev-1", revokedAt: null }],
      "user-2": [{ deviceId: "dev-2", revokedAt: null }],
    };
    presentUsers = new Set(); // both absent ⇒ both get push (default absent_only)
    sendPushSpy.mockRejectedValueOnce(new Error("boom")); // user-1 throws
    await expect(notify(archiveEvent)).resolves.toBeUndefined();
    // Both users were attempted despite user-1 throwing.
    expect(sendPushSpy).toHaveBeenCalledTimes(2);
  });
});
