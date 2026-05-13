import { redirect, type Handle } from "@sveltejs/kit";
import { auth } from "$lib/server/auth";
import { logger } from "$lib/server/log";
import { consumeRateLimit, resetRateLimit } from "@friday/shared/services";

const PUBLIC_PATHS = new Set(["/login", "/api/auth"]);

/** FIX_FORWARD 5.7: sign-in rate limit — 5 attempts per 15-minute window
 *  per client IP, with a 30-minute lockout once the 6th attempt arrives.
 *  Bypassed for non-sign-in auth routes (sign-out, session, etc). */
const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;
const SIGN_IN_MAX = 5;
const SIGN_IN_LOCKOUT_MS = 30 * 60 * 1000;

/**
 * Extract the real client IP. Behind Cloudflare Tunnel the only reliable
 * source is `cf-connecting-ip`; `x-forwarded-for` is often unset or
 * loopback because cloudflared proxies via the local socket. Falling back
 * to `getClientAddress()` would put every CF tunnel user in one shared
 * rate-limit bucket — five bad sign-ins across the household would lock
 * everyone out for 30 minutes.
 */
function clientIp(event: Parameters<Handle>[0]["event"]): string {
  const cf = event.request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const fwd = event.request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return event.getClientAddress();
}

export const handle: Handle = async ({ event, resolve }) => {
  const start = Date.now();

  // BetterAuth route handler — handles /api/auth/* itself
  if (event.url.pathname.startsWith("/api/auth")) {
    // Rate-limit the sign-in attempt before forwarding. /api/auth/sign-in/*
    // covers /sign-in/email; /api/auth/sign-out etc. pass through.
    const isSignIn =
      event.url.pathname.startsWith("/api/auth/sign-in") &&
      event.request.method === "POST";
    const ip = isSignIn ? clientIp(event) : null;
    if (isSignIn && ip) {
      const r = consumeRateLimit({
        key: `auth:${ip}`,
        windowMs: SIGN_IN_WINDOW_MS,
        max: SIGN_IN_MAX,
        lockoutMs: SIGN_IN_LOCKOUT_MS,
      });
      if (!r.allowed) {
        return new Response(
          JSON.stringify({
            error: "rate_limited",
            retry_after_ms: r.retryAfterMs,
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": String(Math.ceil((r.retryAfterMs ?? 0) / 1000)),
            },
          },
        );
      }
    }
    const response = await auth.handler(event.request);
    // Successful sign-in: drop the bucket so a household sharing one
    // public IP (typical CF tunnel deployment) isn't penalized for every
    // legitimate login. The pre-consume above still throttles bursts of
    // bad attempts even before they reach BetterAuth.
    if (isSignIn && ip && response.status >= 200 && response.status < 300) {
      resetRateLimit(`auth:${ip}`);
    }
    return response;
  }

  // Resolve session
  let session: Awaited<ReturnType<typeof auth.api.getSession>> | null = null;
  try {
    session = await auth.api.getSession({ headers: event.request.headers });
  } catch (err) {
    logger.log("warn", "auth.session.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  event.locals.user = session?.user
    ? { id: session.user.id, email: session.user.email, name: session.user.name }
    : null;
  event.locals.session = session?.session
    ? {
        id: session.session.id,
        userId: session.session.userId,
        expiresAt: new Date(session.session.expiresAt),
      }
    : null;

  // Auth gate
  const isPublic = [...PUBLIC_PATHS].some((p) => event.url.pathname.startsWith(p));
  if (!event.locals.user && !isPublic) {
    throw redirect(302, "/login");
  }

  const response = await resolve(event);
  const durationMs = Date.now() - start;
  logger.log(response.status >= 500 ? "error" : "info", "request", {
    method: event.request.method,
    path: event.url.pathname,
    status: response.status,
    durationMs,
    userId: event.locals.user?.id,
  });
  return response;
};
