/**
 * Sliding-window rate limiter backed by the `db_meta` key/value table
 * (FIX_FORWARD 5.7). Persisted to SQLite so the limiter survives daemon
 * and dashboard restarts — a lockout placed seconds before a crash isn't
 * forgotten on the next boot.
 *
 * Used by:
 *   - Dashboard sign-in: 5 attempts / 15min / IP, 30min lockout on the 6th.
 *   - Daemon mail-send: 50 mails / 5min / from-agent.
 *
 * The CLI's `friday setup --reset-password` clears the `auth:` keys so an
 * operator who legitimately forgot their password isn't shut out by a
 * recent failed-login streak.
 */

import { eq, like } from "drizzle-orm";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";

const KEY_PREFIX = "rate_limit:";

interface BucketState {
  hits: number[];
  lockedUntil?: number;
}

function readBucket(fullKey: string): BucketState {
  const db = getDb();
  const row = db
    .select()
    .from(schema.dbMeta)
    .where(eq(schema.dbMeta.key, fullKey))
    .get();
  if (!row) return { hits: [] };
  try {
    return JSON.parse(row.value) as BucketState;
  } catch {
    return { hits: [] };
  }
}

function writeBucket(fullKey: string, b: BucketState): void {
  const db = getDb();
  db.insert(schema.dbMeta)
    .values({ key: fullKey, value: JSON.stringify(b) })
    .onConflictDoUpdate({
      target: schema.dbMeta.key,
      set: { value: JSON.stringify(b) },
    })
    .run();
}

export interface ConsumeOpts {
  /** Logical key — `auth:<ip>` / `mail:<agent>` / etc. The `rate_limit:`
   *  prefix is added automatically for the db_meta row. */
  key: string;
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /** Maximum hits allowed within the window. */
  max: number;
  /** When set, exceeding `max` triggers a lockout of this duration in
   *  addition to the natural window decay. Use for high-cost endpoints
   *  (sign-in). */
  lockoutMs?: number;
}

export interface ConsumeResult {
  allowed: boolean;
  /** Number of hits remaining in the current window after this check
   *  (allowed=false ⇒ 0). */
  remaining: number;
  /** When the caller should retry, in milliseconds from now. */
  retryAfterMs?: number;
}

/**
 * Attempt to record one hit against `opts.key`. Returns `allowed: true`
 * when within the window AND no active lockout; otherwise returns
 * `retryAfterMs` for the soonest retry window.
 */
export function consumeRateLimit(opts: ConsumeOpts): ConsumeResult {
  const fullKey = KEY_PREFIX + opts.key;
  const now = Date.now();
  const bucket = readBucket(fullKey);

  if (bucket.lockedUntil && bucket.lockedUntil > now) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: bucket.lockedUntil - now,
    };
  }
  // Expire stale lockouts so a future check after the window starts
  // fresh, even if no successful call cleared it.
  if (bucket.lockedUntil && bucket.lockedUntil <= now) {
    bucket.lockedUntil = undefined;
  }

  // Drop hits outside the window.
  bucket.hits = bucket.hits.filter((t) => now - t < opts.windowMs);

  if (bucket.hits.length >= opts.max) {
    const oldest = bucket.hits[0];
    let retryAfterMs = opts.windowMs - (now - oldest);
    if (opts.lockoutMs) {
      bucket.lockedUntil = now + opts.lockoutMs;
      retryAfterMs = opts.lockoutMs;
    }
    writeBucket(fullKey, bucket);
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  bucket.hits.push(now);
  writeBucket(fullKey, bucket);
  return { allowed: true, remaining: opts.max - bucket.hits.length };
}

/** Drop a single key's bucket (auth success, manual override). */
export function resetRateLimit(key: string): void {
  const db = getDb();
  db.delete(schema.dbMeta)
    .where(eq(schema.dbMeta.key, KEY_PREFIX + key))
    .run();
}

/** Drop every bucket whose logical key starts with `prefix` (e.g. wipe
 *  every `auth:*` entry when the user resets their password). */
export function resetRateLimitPrefix(prefix: string): number {
  const db = getDb();
  const fullPrefix = KEY_PREFIX + prefix;
  const result = db
    .delete(schema.dbMeta)
    .where(like(schema.dbMeta.key, `${fullPrefix}%`))
    .run();
  return result.changes ?? 0;
}
