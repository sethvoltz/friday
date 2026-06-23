// FRI-142 / ADR-048 — The stateless Notification router (daemon-only).
//
// `notify(event)` is the single entrypoint every producer fires. Per ADR-048 it
// is STATELESS — it holds no cross-event state and stores nothing. For ONE
// event it:
//
//   1. reads the user's NotifyPolicy + DND + critical-bypass off `settings`;
//   2. resolves the OR-aggregated presence verdict (per subscribed user);
//   3. resolves WHICH channels fire (the pure resolveChannels: policy × presence
//      × DND, with the critical class bypassing DND when the toggle is on);
//   4. fires Toast via the daemon eventBus (the new `toast` SSE event) and Push
//      via Daemon-A's `sendPushToUser` fan-out.
//
// FIRE-AND-FORGET: every failure is logged and swallowed — `notify` never throws
// into the producer, and never blocks the originating event. Producers call it
// with `void notify(...)`.
//
// Presence subtlety: presence is OR-aggregated PER USER, and a producer event
// carries no user id (it is machine→human). So the router resolves the set of
// users that hold a push subscription, computes each user's presence from their
// `client_devices` device set, and decides push per-user. Toast, by contrast,
// is broadcast on the single-user SSE side-channel — it is gated by whether ANY
// subscribed user is present (a toast only matters to a present client; an
// absent-everywhere user gets no toast, matching `present_only`). When NO user
// holds a push subscription (fresh install, never subscribed), presence cannot
// be resolved from a device set, so toast still fires for a present client via
// the broadcast path and push is simply a no-op fan-out.

import type { Channel, NotifyEvent, NotifyPolicy } from "@friday/shared";
import { listClientDevicesForUser } from "@friday/shared/services";
import { logger } from "../log.js";
import { eventBus } from "../events/bus.js";
import { isUserPresent, isAnyDevicePresent } from "./presence.js";
import { readNotifySettings, type NotifySettings } from "./settings.js";
import { resolveChannels, isInDndWindow } from "./policy.js";
import { listDistinctSubscriptionUserIds } from "./push-subscriptions.js";
import { sendPushToUser } from "./push-send.js";

/** Event taxonomy keys whose events are always in the critical class. A mail
 *  event opts in per-event via `event.priority === "critical"`. */
const ALWAYS_CRITICAL: ReadonlySet<NotifyEvent["type"]> = new Set(["evolve_critical"]);

/** Whether an event is in the critical class (bypass-eligible): an
 *  `evolve_critical` event, or any event flagged `priority: "critical"` (the
 *  mail `priority='critical'` path). */
function isCriticalEvent(event: NotifyEvent): boolean {
  return ALWAYS_CRITICAL.has(event.type) || event.priority === "critical";
}

/** Local wall-clock as "HH:MM" (24h), for the DND-window check. Uses the host
 *  timezone — the same clock the user set their DND hours in. */
function localHHMM(d: Date = new Date()): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Emit the Toast Channel: the ephemeral `toast` SSE event on the live side-
 *  channel (ADR-024 — no DB row). The eventBus stamps `v`/`seq`. */
function fireToast(event: NotifyEvent): void {
  eventBus.publish({
    v: 1,
    type: "toast",
    title: event.title,
    body: event.body,
    ...(event.deepLink ? { deep_link: event.deepLink } : {}),
    event_type: event.type,
    ...(event.priority ? { priority: event.priority } : {}),
    ts: Date.now(),
  });
}

/** Resolve a user's OR-aggregated presence from their `client_devices` set. An
 *  empty device set ⇒ absent (fail-safe). Defensive: a read failure ⇒ absent. */
async function resolveUserPresence(userId: string): Promise<boolean> {
  try {
    const devices = await listClientDevicesForUser(userId);
    // A revoked ("forgotten") device must not count toward presence — it has no
    // live client and would wrongly keep a user "present" on a stale id.
    const liveDeviceIds = devices.filter((d) => d.revokedAt === null).map((d) => d.deviceId);
    return isUserPresent(liveDeviceIds);
  } catch (err) {
    logger.log("warn", "notify.presence.resolve.error", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false; // unknown ⇒ away ⇒ push (fail-safe)
  }
}

/**
 * Decide + fire the channels for one (event, presence) pair against the loaded
 * settings. Factored out so both the per-user push decision and the broadcast
 * toast decision run through the SAME pure resolver. Returns the resolved
 * decision for logging/aggregation.
 */
function decide(
  event: NotifyEvent,
  present: boolean,
  settings: NotifySettings,
): Record<Channel, boolean> {
  const inDnd = isInDndWindow(localHHMM(), settings.dndStart, settings.dndEnd);
  return resolveChannels({
    eventType: event.type,
    present,
    policy: settings.policy as NotifyPolicy,
    inDnd,
    critical: isCriticalEvent(event),
    criticalBypassDnd: settings.criticalBypassDnd,
  });
}

/**
 * Route one Notification. Stateless, fire-and-forget — never throws.
 *
 * Toast fires once (broadcast on the single SSE side-channel) when policy
 * resolves `toast` against GLOBAL presence — whether ANY reporting device is
 * foregrounded right now (`isAnyDevicePresent`), independent of the push-
 * subscription set. This is what lets a fresh install that never subscribed to
 * Web Push still receive in-app toasts. Push fires per SUBSCRIBED user, gated on
 * that user's OWN device-set presence so the push half is correct even with
 * multiple users (and fail-safe over-pushes an absent/unknown user).
 */
export async function notify(event: NotifyEvent): Promise<void> {
  try {
    const settings = await readNotifySettings();
    const userIds = await listDistinctSubscriptionUserIds();

    // Per-user presence verdicts for the PUSH decision (resolved once each).
    const presenceByUser = new Map<string, boolean>();
    for (const userId of userIds) {
      presenceByUser.set(userId, await resolveUserPresence(userId));
    }

    // --- Toast (broadcast, single SSE side-channel) ---
    // Gated on GLOBAL presence: any foregrounded client ⇒ the toast has a
    // present surface to render on (present_only fires; absent suppresses).
    const toastDecision = decide(event, isAnyDevicePresent(), settings);
    if (toastDecision.toast) fireToast(event);

    // --- Push (per subscribed user, gated on that user's presence) ---
    for (const userId of userIds) {
      const present = presenceByUser.get(userId) ?? false;
      const pushDecision = decide(event, present, settings);
      if (!pushDecision.push) continue;
      try {
        const tally = await sendPushToUser(userId, event);
        logger.log("info", "notify.push.sent", {
          eventType: event.type,
          userId,
          ...tally,
        });
      } catch (err) {
        // sendPushToUser is itself fire-and-forget, but belt-and-braces: a
        // throw here must not abort the fan-out to other users.
        logger.log("warn", "notify.push.error", {
          eventType: event.type,
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.log("info", "notify.routed", {
      eventType: event.type,
      priority: event.priority ?? "normal",
      critical: isCriticalEvent(event),
      toast: toastDecision.toast,
      pushUsers: userIds.length,
    });
  } catch (err) {
    // The whole router is fire-and-forget: a settings/subscription read failure
    // must never propagate into the producer's path.
    logger.log("warn", "notify.error", {
      eventType: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
