import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

/**
 * FRI-142 (ADR-048): "Send test notification" trigger. The Settings card POSTs
 * here from a button tap; we proxy over loopback to the daemon's Notification
 * router (`POST /api/notify/test`), which fires a `builder_archive`-class test
 * Notification through the SAME router path a real producer uses — resolving
 * policy × presence × DND, then firing Toast (if present) and/or Push (if
 * absent + subscribed). This is how Seth confirms the end-to-end round-trip
 * (permission grant, SW push handler, badge, deep-link) on his installed PWA.
 *
 * Session-gated (NOT a `PUBLIC_PATH`) — the trigger comes from the foregrounded
 * signed-in app, so `locals.user` is set; a missing session 401s here rather
 * than redirecting. `withDaemon` injects `x-friday-daemon-secret` and
 * classifies transport failures into structured 502/504 responses.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  return withDaemon((d) => d.post("/api/notify/test", {}, { signal: request.signal }));
};
