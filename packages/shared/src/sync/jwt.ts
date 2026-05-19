// HS256 JWT helpers used by the dashboard <-> zero-cache bridge.
//
// Zero 1.5 still accepts a symmetric-key signed JWT (`--auth-secret`,
// `ZERO_AUTH_SECRET`); the JWT shape carries our `{userId, deviceId, iat,
// exp}` claims through to permissions and inspector access. Tokens are
// short-lived (default 15 minutes) so a forgotten device can be revoked
// by deleting its `client_devices` row plus rejecting new mints — without
// having to nuke a long-lived token's signature.
//
// We use Node's built-in `crypto.createHmac('sha256', secret)` and
// hand-roll base64url + JSON serialization — no new dependency needed.
// The mint/verify pair is intentionally tiny and dependency-free so the
// daemon's tests can exercise it without pulling in jose / jsonwebtoken.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface ZeroJwtClaims {
  /** BetterAuth user id from the session. */
  userId: string;
  /** Stable per-browser-install device id; client_devices.device_id. */
  deviceId: string;
  /** Seconds since epoch when the token was issued. */
  iat: number;
  /** Seconds since epoch when the token expires. */
  exp: number;
}

export interface MintOptions {
  userId: string;
  deviceId: string;
  /** Token lifetime in seconds. Default 900 (15 min). */
  ttlSec?: number;
  /** Symmetric HMAC key. Must match the zero-cache `--auth-secret`. */
  secret: string;
  /** Override `now` for testing. */
  nowSec?: number;
}

/** Mint a fresh JWT (HS256) for the dashboard ↔ zero-cache bridge. */
export function mintZeroJwt(opts: MintOptions): string {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSec ?? 900;
  const header = { alg: "HS256", typ: "JWT" };
  const payload: ZeroJwtClaims = {
    userId: opts.userId,
    deviceId: opts.deviceId,
    iat: now,
    exp: now + ttl,
  };
  const signing =
    base64UrlEncode(JSON.stringify(header)) +
    "." +
    base64UrlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", opts.secret).update(signing).digest();
  return signing + "." + base64UrlEncodeBuffer(sig);
}

/**
 * Verify and decode a JWT minted by `mintZeroJwt`. Returns the claims or
 * `null` if the signature is invalid / the token is expired / the
 * structure is malformed. Uses `timingSafeEqual` for the signature
 * compare so we don't leak validity by side-channel.
 */
export function verifyZeroJwt(
  token: string,
  secret: string,
  nowSec?: number,
): ZeroJwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encHeader, encPayload, encSig] = parts;
  const signing = `${encHeader}.${encPayload}`;
  const expected = createHmac("sha256", secret).update(signing).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(encSig, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isClaims(payload)) return null;
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return null;
  return payload;
}

function isClaims(v: unknown): v is ZeroJwtClaims {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.userId === "string" &&
    typeof o.deviceId === "string" &&
    typeof o.iat === "number" &&
    typeof o.exp === "number"
  );
}

function base64UrlEncode(input: string): string {
  return base64UrlEncodeBuffer(Buffer.from(input, "utf8"));
}

function base64UrlEncodeBuffer(buf: Buffer): string {
  return buf.toString("base64url");
}
