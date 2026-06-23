// FRI-142 / ADR-048 — `push_subscriptions` repository (daemon-only, server-only).
//
// One row per browser push registration, keyed by the unique `endpoint`. SERVER-
// ONLY: this table is absent from `SYNC_TABLES` and the Zero schema (the `apikey`
// precedent) — the endpoint + ECDH keys are sensitive, and the client learns its
// own subscription from `pushManager.getSubscription()`. The daemon's
// Notification router is the single server-side holder of these rows + the VAPID
// private key.
//
// Lifecycle:
//   - `upsertSubscription`  — POST /api/push/subscribe writes/refreshes a row,
//     deduped by `endpoint`.
//   - `listSubscriptionsForUser` — the push-send fan-out reads all of a user's
//     registrations.
//   - `deleteSubscriptionByEndpoint` — stale-endpoint cleanup on a 404/410.
//   - `dropSubscriptionsForDevice` — "Forget this device" (a `revoked_at` write)
//     drops every subscription for that device.

import { and, eq } from "drizzle-orm";
import { getDb, schema, type PushSubscribePayload } from "@friday/shared";

/** A stored push subscription, in the shape the `web-push` send path needs. */
export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userId: string;
  deviceId: string | null;
}

/**
 * Insert or refresh a subscription, deduped by the unique `endpoint`. On a repeat
 * registration of the same endpoint (the browser re-subscribed, or another
 * device hit the same push service URL — which cannot happen across endpoints but
 * can on re-subscribe) the keys, owner, device, and `last_seen_at` are updated in
 * place. `created_at` is preserved (only set on first insert).
 *
 * Returns the resolved `endpoint` (the dedup key) so callers can log/test.
 */
export async function upsertSubscription(
  payload: PushSubscribePayload,
  userId: string,
): Promise<{ endpoint: string }> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(schema.pushSubscriptions)
    .values({
      endpoint: payload.endpoint,
      p256dh: payload.keys.p256dh,
      auth: payload.keys.auth,
      userId,
      deviceId: payload.deviceId,
      createdAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: schema.pushSubscriptions.endpoint,
      set: {
        p256dh: payload.keys.p256dh,
        auth: payload.keys.auth,
        userId,
        deviceId: payload.deviceId,
        lastSeenAt: now,
      },
    });
  return { endpoint: payload.endpoint };
}

/**
 * Every DISTINCT `user_id` that currently holds at least one push registration.
 * The Notification router fans a producer event (which carries no user id — it
 * is machine→human) out to every subscribed user. Friday is single-user in
 * practice, so this is normally one id; resolving it from the subscription set
 * keeps the router free of any ambient "the user" assumption.
 */
export async function listDistinctSubscriptionUserIds(): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .selectDistinct({ userId: schema.pushSubscriptions.userId })
    .from(schema.pushSubscriptions);
  return rows.map((r) => r.userId);
}

/** All of a user's push registrations, projected for the `web-push` send path. */
export async function listSubscriptionsForUser(userId: string): Promise<StoredSubscription[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.userId, userId));
  return rows.map((r) => ({
    endpoint: r.endpoint,
    keys: { p256dh: r.p256dh, auth: r.auth },
    userId: r.userId,
    deviceId: r.deviceId ?? null,
  }));
}

/**
 * Delete the row matching `endpoint`. The stale-subscription cleanup the push
 * send path calls on a 404/410 from the push service. Idempotent — deleting a
 * non-existent endpoint matches zero rows.
 */
export async function deleteSubscriptionByEndpoint(endpoint: string): Promise<void> {
  const db = getDb();
  await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, endpoint));
}

/**
 * Drop every subscription belonging to a device. Called when "Forget this device"
 * writes `client_devices.revoked_at` — a forgotten device must not keep receiving
 * pushes. Scoped to `(deviceId, userId)` so a forget can never reach across users.
 */
export async function dropSubscriptionsForDevice(deviceId: string, userId: string): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.pushSubscriptions)
    .where(
      and(
        eq(schema.pushSubscriptions.deviceId, deviceId),
        eq(schema.pushSubscriptions.userId, userId),
      ),
    );
}
