import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

/**
 * FRI-142 (ADR-048): expose the daemon's VAPID PUBLIC key to the client so it
 * can pass it as the `applicationServerKey` to `pushManager.subscribe(...)`.
 * Only the public half is ever served — the VAPID PRIVATE key never leaves the
 * daemon. Session-gated like the other notification routes (the subscribe flow
 * runs in the foregrounded, signed-in app).
 *
 * The daemon returns `{ publicKey }` (URL-safe base64). We proxy it verbatim;
 * the client converts it to a `Uint8Array` before subscribing.
 */
export const GET: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  return withDaemon((d) => d.get("/api/push/vapid-public-key", { signal: request.signal }));
};
