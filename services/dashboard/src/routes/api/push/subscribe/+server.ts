import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

/**
 * FRI-142 (ADR-048): register this browser's Web Push subscription with the
 * daemon. Session-gated (NOT a `PUBLIC_PATH`) — the foregrounded app holds a
 * BetterAuth session, so `locals.user` is populated by `hooks.server.ts` and a
 * missing session 401s here rather than 302→/login.
 *
 * The body is a `PushSubscribePayload` (`{ endpoint, keys: { p256dh, auth },
 * deviceId }`) the client derived from `pushManager.subscribe(...)`. We proxy
 * it over loopback to the daemon, which owns the VAPID private key and the
 * server-only `push_subscriptions` table — the dashboard never touches either.
 *
 * The owning `userId` is stamped from the verified server session
 * (`locals.user.id`) — never trust a client-supplied user id, and the
 * `PushSubscribePayload` the client sends carries no `userId` field. The daemon
 * keys `push_subscriptions.user_id` off this value (the same id
 * `client_devices.user_id` carries), so without it the daemon 400s and no row
 * is ever written. `withDaemon` injects the `x-friday-daemon-secret` and
 * classifies transport failures into structured 502/504 responses.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = await request.json();
  return withDaemon((d) =>
    d.post(
      "/api/push/subscribe",
      { ...(body as object), userId: locals.user!.id },
      { signal: request.signal },
    ),
  );
};
