// FRI-142 / ADR-048 — VAPID keypair management (daemon-only, server-only).
//
// The daemon is the SINGLE server-side holder of the VAPID private key. The
// keypair lives in the server-only `web_push_vapid` Postgres table (NOT a
// `~/.friday/vapid.json` file, NOT the Zero-replicated `settings` table) — see
// the schema.ts comment for why: it MUST ride the same `pg_dump` as
// `push_subscriptions`, or a restore to a new machine regenerates the keypair
// and silently kills every existing subscription (the browser subscribed
// against the OLD public key → the push service returns 410/404 for all of
// them). The PUBLIC key is exposed to clients (the dashboard fetches it to pass
// as `applicationServerKey` to `pushManager.subscribe`); the PRIVATE key never
// leaves this module.
//
// `web-push` is a DAEMON-ONLY dependency. This module (and everything in
// `notifications/`) must never be imported from `packages/shared/src/sync/`, the
// dashboard browser bundle, or the service worker.

import webpush from "web-push";
import { getDb, loadConfig, schema } from "@friday/shared";
import { logger } from "../log.js";

/** The persisted VAPID keypair shape (URL-safe base64 strings). */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * Last-resort `sub` claim for a fresh install with no `publicUrl` configured.
 * Apple's APNs Web Push gateway rejects this with HTTP 403 (a `mailto:` with a
 * non-routable domain — see `resolveVapidSubject`), but Mozilla/FCM accept it,
 * so a box pre-tunnel can still reach those subscribers.
 */
const DEFAULT_VAPID_SUBJECT = "mailto:friday@localhost";

/**
 * Resolve the VAPID `sub` claim. Apple's APNs Web Push gateway enforces VAPID
 * strictly — it rejects a `mailto:` whose domain isn't routable (e.g.
 * `localhost`) with HTTP 403, killing every push send to an iOS PWA. Mozilla
 * and FCM are lenient, so this only ever surfaces on Apple devices.
 *
 * Resolution order (first match wins):
 *   1. An explicit `override` from the caller.
 *   2. `cfg.publicUrl` (the Cloudflare-exposed dashboard URL) if it's an
 *      `https://...` URI — the production case, and an `https:` URI is one of
 *      the two forms VAPID itself permits, so Apple accepts it.
 *   3. `mailto:friday@localhost` fallback (will fail on Apple; works elsewhere).
 *
 * Pure: takes the publicUrl as an argument so it can be unit-tested without
 * touching disk or the shared-config loader.
 */
export function resolveVapidSubject(
  publicUrl: string | undefined,
  override?: string,
): string {
  if (override) return override;
  if (publicUrl && /^https:\/\//.test(publicUrl)) return publicUrl;
  return DEFAULT_VAPID_SUBJECT;
}

/** The literal single-row PK for `web_push_vapid` (the `settings` precedent). */
const SINGLETON_ID = "singleton";

// Process-lifetime cache: the keypair is read/generated once and reused. Also
// the latch that ensures `setVapidDetails` is called exactly once per boot.
let cached: VapidKeys | null = null;
let configured = false;

/**
 * Load the keypair from the server-only `web_push_vapid` table, generating +
 * persisting one on first use. ATOMIC + idempotent across processes and
 * concurrent callers: a single `INSERT … ON CONFLICT (id) DO NOTHING` races to
 * seed the singleton row (the keypair is generated ONLY for the insert attempt),
 * then a `SELECT` reads back whichever row won — so two concurrent daemons (or
 * two concurrent first-push paths) converge on ONE keypair with no read-then-
 * write race and no regeneration. Cached in-process after the first resolve.
 *
 * Regeneration would invalidate every existing `push_subscriptions` row, so the
 * `ON CONFLICT DO NOTHING` is load-bearing: the keypair is written exactly once
 * for the life of the database and never overwritten.
 */
export async function ensureVapidKeys(): Promise<VapidKeys> {
  if (cached) return cached;

  const db = getDb();
  // Generate a candidate keypair, but only the INSERT that wins the race
  // actually persists it (ON CONFLICT DO NOTHING drops the loser's keypair).
  const candidate = webpush.generateVAPIDKeys();
  const inserted = await db
    .insert(schema.webPushVapid)
    .values({
      id: SINGLETON_ID,
      publicKey: candidate.publicKey,
      privateKey: candidate.privateKey,
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: schema.webPushVapid.id })
    .returning({ publicKey: schema.webPushVapid.publicKey });

  if (inserted.length > 0) {
    logger.log("info", "vapid.keys.generated", {});
  }

  // SELECT the canonical row — whether we just inserted it or a concurrent
  // caller / prior boot did. This is the single source of truth.
  const rows = await db
    .select({
      publicKey: schema.webPushVapid.publicKey,
      privateKey: schema.webPushVapid.privateKey,
    })
    .from(schema.webPushVapid);

  const row = rows[0];
  if (!row) {
    // Should be unreachable: we just inserted-or-conflicted on the singleton.
    throw new Error("web_push_vapid singleton row missing after ensure");
  }
  cached = { publicKey: row.publicKey, privateKey: row.privateKey };
  return cached;
}

/**
 * Ensure `web-push` is configured with this daemon's VAPID details. Loads/creates
 * the keypair, then calls `setVapidDetails` exactly once per process. Every push
 * send path calls this first so a fresh boot (or a never-pushed install) is wired
 * lazily on the first send rather than requiring boot-time setup.
 */
export async function ensureVapidConfigured(subject?: string): Promise<VapidKeys> {
  const keys = await ensureVapidKeys();
  if (!configured) {
    // Read publicUrl defensively: ADR-048 requires this path to "never crash
    // boot" (it is boot-ensured best-effort), but `loadConfig` does a bare
    // `JSON.parse(readFileSync(...))` and will throw SyntaxError on a corrupt
    // config.json. Swallow any read/parse failure and fall through to the
    // localhost fallback — push degrades, the daemon keeps running.
    let publicUrl: string | undefined;
    try {
      publicUrl = loadConfig().publicUrl;
    } catch (err) {
      logger.log("warn", "vapid.config.read.error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const resolved = resolveVapidSubject(publicUrl, subject);
    webpush.setVapidDetails(resolved, keys.publicKey, keys.privateKey);
    logger.log("info", "vapid.configured", { sub: resolved });
    configured = true;
  }
  return keys;
}

/**
 * The PUBLIC VAPID key clients need for `pushManager.subscribe`. Safe to expose
 * — it is the application server's public identity, by design shared with every
 * subscriber. The private key never leaves `ensureVapidKeys`.
 */
export async function getVapidPublicKey(): Promise<string> {
  return (await ensureVapidKeys()).publicKey;
}

/** Test-only: reset the process-lifetime cache so a test can re-exercise the
 *  load/generate path against a fresh scratch DB. */
export function __resetVapidCacheForTest(): void {
  cached = null;
  configured = false;
}
