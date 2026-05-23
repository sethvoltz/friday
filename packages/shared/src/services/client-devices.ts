// Per-browser-install device registry. Each client opens a Zero sync
// session with a stable `deviceId` (UUID, generated client-side and
// stored in localStorage); the dashboard's `/api/sync/refresh` endpoint
// upserts a row into `client_devices` on every JWT mint, so the
// `Settings → Devices` page can show "iPhone 15 — last seen 3 min ago"
// and the `Forget this device` button has something concrete to revoke.
//
// The table is sync-eligible (Phase 3 slice), but Phase 2 only writes to
// it from the server's mint path — no client-side mutators yet.

import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";

export interface ClientDeviceRow {
  deviceId: string;
  userId: string;
  userAgent: string | null;
  label: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  storageUsedBytes: number | null;
  storageQuotaBytes: number | null;
  lastSyncAt: number | null;
  /** Plan §41: non-null means the device has been forgotten. The
   *  refresh handler denies JWT minting for revoked rows. */
  revokedAt: number | null;
}

function rowToClientDevice(r: typeof schema.clientDevices.$inferSelect): ClientDeviceRow {
  return {
    deviceId: r.deviceId,
    userId: r.userId,
    userAgent: r.userAgent,
    label: r.label,
    firstSeenAt: r.firstSeenAt.getTime(),
    lastSeenAt: r.lastSeenAt.getTime(),
    storageUsedBytes: r.storageUsedBytes,
    storageQuotaBytes: r.storageQuotaBytes,
    lastSyncAt: r.lastSyncAt ? r.lastSyncAt.getTime() : null,
    revokedAt: r.revokedAt ? r.revokedAt.getTime() : null,
  };
}

export async function getClientDevice(deviceId: string): Promise<ClientDeviceRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.clientDevices)
    .where(eq(schema.clientDevices.deviceId, deviceId))
    .limit(1);
  return rows[0] ? rowToClientDevice(rows[0]) : null;
}

export interface UpsertClientDeviceInput {
  deviceId: string;
  userId: string;
  userAgent?: string | null;
}

/**
 * Insert a `client_devices` row on first sight, or refresh its
 * `last_seen_at` (and any updated `user_agent`) on every subsequent
 * sight. `userId` is pinned on first insert — a deviceId moving between
 * users is a security event the dashboard rejects upstream, so we don't
 * need to merge / migrate ownership here.
 */
export async function upsertClientDevice(input: UpsertClientDeviceInput): Promise<ClientDeviceRow> {
  const db = getDb();
  const now = new Date();
  const ua = input.userAgent ?? null;

  await db
    .insert(schema.clientDevices)
    .values({
      deviceId: input.deviceId,
      userId: input.userId,
      userAgent: ua,
      label: null,
      firstSeenAt: now,
      lastSeenAt: now,
      lastSyncAt: now,
    })
    .onConflictDoUpdate({
      target: schema.clientDevices.deviceId,
      set: {
        lastSeenAt: now,
        lastSyncAt: now,
        // Refresh userAgent if the caller passed a fresh one (e.g.
        // browser upgraded). Don't clobber with null.
        ...(ua ? { userAgent: ua } : {}),
      },
    });

  const row = await getClientDevice(input.deviceId);
  if (!row) {
    throw new Error(
      `upsertClientDevice: row not found after insert for deviceId=${input.deviceId}`,
    );
  }
  return row;
}

export async function listClientDevicesForUser(userId: string): Promise<ClientDeviceRow[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.clientDevices)
    .where(eq(schema.clientDevices.userId, userId));
  return rows.map(rowToClientDevice);
}

/**
 * Hard-delete a device. The dashboard's "Forget this device" button
 * calls this; the next time that client tries to refresh its JWT, the
 * mint endpoint will re-upsert and the user will need to manually
 * forget again — so production usage couples this with a sign-out on
 * the affected device. Phase 6 adds the UI; Phase 2 just exposes the
 * primitive.
 */
export async function forgetClientDevice(deviceId: string, userId: string): Promise<boolean> {
  const db = getDb();
  const result = await db
    .delete(schema.clientDevices)
    .where(eq(schema.clientDevices.deviceId, deviceId));
  // Drizzle pg returns the affected row count via the QueryResult's
  // rowCount property; coerce nullable to 0 for the boolean return.
  void userId; // reserved — Phase 6 adds ownership check
  return (result.rowCount ?? 0) > 0;
}

/**
 * Plan §41: soft-delete a device via the `revoked_at` tombstone. This
 * is what the `forgetDevice` mutator's server-side body does too;
 * exposed as a service helper so non-mutator callers (tests, daemon
 * boot recovery) can drive the same state transition without the
 * Zero push pipeline.
 *
 * Idempotent: setting `revoked_at` on an already-revoked row is a
 * no-op write (the column value updates to the new `ts`, which is
 * fine — the deny gate only checks `IS NOT NULL`).
 */
export async function revokeClientDevice(
  deviceId: string,
  revokedAt: Date = new Date(),
): Promise<boolean> {
  const db = getDb();
  const result = await db
    .update(schema.clientDevices)
    .set({ revokedAt })
    .where(eq(schema.clientDevices.deviceId, deviceId));
  return (result.rowCount ?? 0) > 0;
}
