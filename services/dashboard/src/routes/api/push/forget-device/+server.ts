import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

/**
 * FRI-142 (ADR-048), AC7: the "Forget this device" push-subscription cascade.
 *
 * The dashboard's `forgetDevice` mutator writes `client_devices.revoked_at` via
 * Zero (no daemon LISTEN fires on that write), so dropping the device's
 * server-only `push_subscriptions` rows needs a separate hook. The client's
 * `zeroSync.forgetDevice(deviceId)` POSTs here right after firing the mutator;
 * we proxy over loopback to the daemon's `POST /api/push/forget-device`, which
 * owns the server-only `push_subscriptions` table and runs the scoped drop.
 *
 * The daemon scopes the drop to `(deviceId, userId)`. We take `deviceId` from
 * the request body but `userId` from the verified server session
 * (`locals.user.id`) — never trust a client-supplied user id. Idempotent: a
 * device with no subscriptions drops zero rows.
 *
 * Session-gated (NOT a `PUBLIC_PATH`) — the trigger comes from the foregrounded
 * signed-in app, so `locals.user` is set; a missing session 401s here rather
 * than redirecting. `withDaemon` injects `x-friday-daemon-secret` and classifies
 * transport failures into structured 502/504 responses.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = (await request.json()) as { deviceId?: unknown };
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  if (!deviceId) {
    return new Response(JSON.stringify({ error: "deviceId is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  return withDaemon((d) =>
    d.post(
      "/api/push/forget-device",
      { deviceId, userId: locals.user!.id },
      { signal: request.signal },
    ),
  );
};
