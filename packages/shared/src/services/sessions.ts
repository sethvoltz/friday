import { and, desc, eq, gt } from "drizzle-orm";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";

/**
 * Wrappers around the BetterAuth `session` table for the dashboard's
 * Active Sessions UI (FIX_FORWARD 5.11) and the CLI's
 * `friday setup --reset-password` flow.
 *
 * BetterAuth owns the table; we just provide read + revoke helpers that
 * tunnel through Drizzle so callers don't have to import drizzle-orm
 * directly (the dashboard doesn't depend on it).
 */

export interface AuthSession {
  id: string;
  userId: string;
  /** Cookie token (sensitive — never expose to UI). */
  token: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

function rowToAuthSession(
  r: typeof schema.sessions.$inferSelect,
): AuthSession {
  return {
    id: r.id,
    userId: r.userId,
    token: r.token,
    ipAddress: r.ipAddress ?? null,
    userAgent: r.userAgent ?? null,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
    expiresAt: r.expiresAt.getTime(),
  };
}

/** Active (non-expired) sessions for a user, newest first. */
export function listActiveSessionsForUser(userId: string): AuthSession[] {
  const db = getDb();
  const now = new Date();
  const rows = db
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.userId, userId),
        gt(schema.sessions.expiresAt, now),
      ),
    )
    .orderBy(desc(schema.sessions.createdAt))
    .all();
  return rows.map(rowToAuthSession);
}

/** Revoke one session by id. Returns the number of rows deleted (0 or 1). */
export function revokeSessionById(userId: string, id: string): number {
  const db = getDb();
  const result = db
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.id, id), eq(schema.sessions.userId, userId)))
    .run();
  return result.changes ?? 0;
}

/** Revoke every session for a user (including the caller's current one). */
export function revokeAllSessionsForUser(userId: string): number {
  const db = getDb();
  const result = db
    .delete(schema.sessions)
    .where(eq(schema.sessions.userId, userId))
    .run();
  return result.changes ?? 0;
}
