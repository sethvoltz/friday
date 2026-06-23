// FRI-142 / ADR-048 — Web Push send path (daemon-only, server-only).
//
// Fires a native Web Push to every registration a user holds. The payload is
// deliberately TERSE — title + body + badge + deepLink only, NO chat content and
// NO PII (the in-app toast may carry richer text since it never crosses the
// device boundary the same way; a push transits a third-party push service).
//
// `web-push` is DAEMON-ONLY: never import this module from the dashboard browser
// bundle or the service worker.
//
// Stale cleanup: the push service returns 404 (Not Found) or 410 (Gone) for an
// expired/unsubscribed endpoint. On either, the matching `push_subscriptions`
// row is deleted so the daemon stops trying to reach a dead endpoint.

import webpush, { WebPushError } from "web-push";
import type { NotifyEvent } from "@friday/shared";
import { logger } from "../log.js";
import { ensureVapidConfigured } from "./vapid.js";
import { computeBadgeCount } from "./badge.js";
import {
  deleteSubscriptionByEndpoint,
  listSubscriptionsForUser,
  type StoredSubscription,
} from "./push-subscriptions.js";

/**
 * The exact JSON shape delivered to the service worker's `push` handler. TERSE by
 * contract — the SW reads `title`/`body` for `showNotification`, `badge` for
 * `navigator.setAppBadge`, and `deepLink` for the `notificationclick` focus/open.
 * No field carries chat content or PII.
 */
export interface PushPayload {
  title: string;
  body: string;
  /** Open attention-worthy inbox count, recomputed at send time. */
  badge: number;
  /** Route to focus/open on tap; omitted when the event is not actionable. */
  deepLink?: string;
  /** The originating NotifyEventType, for SW-side grouping/tagging. */
  eventType: string;
}

/** Push service status codes that mean "this endpoint is dead — forget it". */
const STALE_STATUS_CODES = new Set([404, 410]);

/**
 * Build the terse push payload for an event. The `badge` is recomputed from the
 * open attention-worthy `inbox_items` at send time (single source of truth;
 * ADR-048 default 5(a)) — one `COUNT(*)` per push, low frequency. The title/body
 * are exactly the event's pre-authored terse fields; nothing else leaks.
 */
export async function buildPushPayload(event: NotifyEvent): Promise<PushPayload> {
  const badge = await computeBadgeCount();
  const payload: PushPayload = {
    title: event.title,
    body: event.body,
    badge,
    eventType: event.type,
  };
  if (event.deepLink) payload.deepLink = event.deepLink;
  return payload;
}

/**
 * Send one push to one stored subscription. On a `WebPushError` whose
 * `statusCode` is 404/410, deletes the stale `push_subscriptions` row and returns
 * `"stale"`. Any other send error is logged and returns `"error"` (the row is
 * kept — a transient failure must not drop a live subscription). A 2xx returns
 * `"sent"`. Never throws — the caller is fire-and-forget.
 */
export async function sendToSubscription(
  sub: StoredSubscription,
  payload: PushPayload,
): Promise<"sent" | "stale" | "error"> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(payload),
    );
    return "sent";
  } catch (err) {
    if (err instanceof WebPushError && STALE_STATUS_CODES.has(err.statusCode)) {
      await deleteSubscriptionByEndpoint(sub.endpoint);
      logger.log("info", "push.subscription.stale.deleted", {
        endpoint: sub.endpoint,
        statusCode: err.statusCode,
      });
      return "stale";
    }
    logger.log("warn", "push.send.error", {
      endpoint: sub.endpoint,
      statusCode: err instanceof WebPushError ? err.statusCode : undefined,
      error: err instanceof Error ? err.message : String(err),
    });
    return "error";
  }
}

/**
 * Fan a single Notification out to every push registration a user holds. Builds
 * the terse payload once (one badge recompute), configures VAPID, then sends to
 * each subscription, cleaning up stale endpoints as it goes. Fire-and-forget:
 * a per-endpoint failure never aborts the fan-out and never throws to the caller.
 *
 * Returns a per-outcome tally (sent / stale / error) for logging + tests.
 */
export async function sendPushToUser(
  userId: string,
  event: NotifyEvent,
): Promise<{ sent: number; stale: number; error: number }> {
  await ensureVapidConfigured();
  const subs = await listSubscriptionsForUser(userId);
  const tally = { sent: 0, stale: 0, error: 0 };
  if (subs.length === 0) return tally;

  const payload = await buildPushPayload(event);
  for (const sub of subs) {
    const outcome = await sendToSubscription(sub, payload);
    tally[outcome] += 1;
  }
  return tally;
}
