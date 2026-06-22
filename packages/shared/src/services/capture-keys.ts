// FRI-171 (ADR-047): server-side raw-DB helpers for Capture-key management
// that don't go through the BetterAuth apiKey plugin's session-scoped
// endpoints. The plugin's `listApiKeys`/`deleteApiKey` run behind
// sessionMiddleware and scope to the request's session user — unusable from
// the loopback CLI path, which has no session. These helpers resolve the
// single Friday account directly and operate on the `apikey` table for the
// `friday capture-key list` / `revoke` CLI surfaces.
//
// Minting still goes through `auth.api.createApiKey` (the only path that can
// stamp the server-only `capture:["write"]` permission scope); it lives in
// the dashboard route, not here, because the plugin is dashboard-only.

import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";

/** A Capture-key row projected to the management-safe view (never the secret). */
export interface CaptureKeyRow {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  enabled: boolean;
  /** Epoch-millis. */
  createdAt: number;
  /** Epoch-millis, or null if never used. */
  lastRequestAt: number | null;
  /** Epoch-millis, or null if non-expiring. */
  expiresAt: number | null;
}

function toRow(r: typeof schema.apikeys.$inferSelect): CaptureKeyRow {
  return {
    id: r.id,
    name: r.name,
    start: r.start,
    prefix: r.prefix,
    enabled: r.enabled,
    createdAt: r.createdAt.getTime(),
    lastRequestAt: r.lastRequest ? r.lastRequest.getTime() : null,
    expiresAt: r.expiresAt ? r.expiresAt.getTime() : null,
  };
}

/**
 * Resolve the single Friday account id. Public sign-up is permanently
 * disabled (the sole account is created by `friday setup`), so there is one
 * `user` row in normal operation; the earliest-created is chosen to stay
 * deterministic if a fixture ever seeds more than one. Returns null when no
 * account exists yet.
 */
export async function resolveSoleUserId(): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.users.id, createdAt: schema.users.createdAt })
    .from(schema.users);
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return rows[0]!.id;
}

/** List a user's Capture keys (metadata only — never the hashed/plaintext key). */
export async function listCaptureKeysForUser(userId: string): Promise<CaptureKeyRow[]> {
  const db = getDb();
  const rows = await db.select().from(schema.apikeys).where(eq(schema.apikeys.referenceId, userId));
  return rows.map(toRow);
}

/**
 * Revoke a Capture key by id — preserve-over-delete: the row is kept (for
 * audit) but `enabled` is flipped false so the key stops verifying. Scoped to
 * `userId`; returns false when the id doesn't exist or belongs to someone else.
 */
export async function revokeCaptureKey(userId: string, keyId: string): Promise<boolean> {
  const db = getDb();
  const updated = await db
    .update(schema.apikeys)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(schema.apikeys.id, keyId))
    .returning({ id: schema.apikeys.id, referenceId: schema.apikeys.referenceId });
  const row = updated[0];
  return !!row && row.referenceId === userId;
}
