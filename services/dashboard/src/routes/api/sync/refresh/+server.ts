import { json, type RequestHandler } from "@sveltejs/kit";
import { randomUUID } from "node:crypto";
import { mintZeroJwt } from "@friday/shared/sync/jwt";
import { getClientDevice, upsertClientDevice } from "@friday/shared/services";

/**
 * Phase 2 (ADR-024): mint a short-lived JWT that the dashboard's Zero
 * client uses to authenticate to `zero-cache`. The token carries
 * `{userId, deviceId, iat, exp}`; zero-cache verifies the HS256
 * signature against `ZERO_AUTH_SECRET` and forwards the claims to
 * downstream permissions / inspector RPC.
 *
 * Side effects on every call:
 *   - Ensures `friday-device-id` cookie is set (generates a new UUID on
 *     first visit; the same value sticks for the lifetime of the
 *     browser profile + matching localStorage so `Forget this device`
 *     can revoke the cookie without orphaning the row).
 *   - Upserts `client_devices` (Phase 2 row-state pre/post-condition:
 *     row exists + `last_sync_at = now()` after the call).
 *
 * Returns:
 *   `{ token, deviceId, expiresAt }` — the Zero client consumes `token`
 *   and re-fetches just before `expiresAt` expires.
 *
 * NB: separate from `/api/auth/*` (BetterAuth's surface) — this is the
 * Zero auth bridge, gated by the BetterAuth session that lives in
 * `event.locals.user`.
 */

const DEVICE_COOKIE = "friday-device-id";
const TOKEN_TTL_SEC = 15 * 60; // 15 min — matches default in mintZeroJwt

export const POST: RequestHandler = async ({ cookies, locals, request }) => {
  if (!locals.user) {
    return new Response("unauthorized", { status: 401 });
  }
  const secret = process.env.ZERO_AUTH_SECRET;
  if (!secret) {
    // Setup invariant: ensureFridayEnv() generates ZERO_AUTH_SECRET. A
    // missing value at this point means the dashboard was launched
    // without going through `friday setup` — fail loudly.
    return new Response("zero-auth-secret-missing", { status: 500 });
  }

  let deviceId = cookies.get(DEVICE_COOKIE);
  if (!deviceId) {
    deviceId = randomUUID();
    cookies.set(DEVICE_COOKIE, deviceId, {
      path: "/",
      httpOnly: false, // readable by the client so it can include in WS subprotocol if needed
      sameSite: "lax",
      // Long expiry — the cookie is the per-browser-install identity.
      // Forget-device revokes the row, not the cookie.
      maxAge: 60 * 60 * 24 * 365 * 5, // 5 years
    });
  } else {
    // Plan §41: if the user previously clicked "Forget this device" on
    // this device_id, the row's `revoked_at` tombstone is set. Deny
    // any further JWT minting against that id and clear the local
    // cookie so the next request mints a fresh device. This is the
    // load-bearing line that made the prior delete-only mutator
    // cosmetic — without this gate, the next refresh just re-upserted
    // the row and the "forget" had no security effect.
    const existing = await getClientDevice(deviceId);
    if (existing && existing.revokedAt !== null) {
      cookies.delete(DEVICE_COOKIE, { path: "/" });
      return new Response("device-revoked", { status: 401 });
    }
  }

  const userAgent = request.headers.get("user-agent");

  await upsertClientDevice({
    deviceId,
    userId: locals.user.id,
    userAgent,
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const token = mintZeroJwt({
    userId: locals.user.id,
    deviceId,
    secret,
    nowSec,
    ttlSec: TOKEN_TTL_SEC,
  });

  return json({
    token,
    deviceId,
    // The Zero client passes `userID` at construction; Zero's JWT
    // validator requires `sub === userID`. Mint the JWT with
    // `sub = locals.user.id` and surface the same value here so the
    // client constructs Zero with the matching userID.
    userId: locals.user.id,
    expiresAt: (nowSec + TOKEN_TTL_SEC) * 1000,
  });
};

// GET aliases POST so the Zero client can fetch with a simple GET if it
// prefers (the body is identical; the side effects are idempotent).
export const GET: RequestHandler = (event) => POST(event);
