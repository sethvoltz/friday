import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

/**
 * FRI-142 (ADR-048): client→daemon presence heartbeat. The foregrounded app
 * POSTs a `PresenceReport` (`{ deviceId, visible }`) on `visibilitychange` and
 * a ~20s keepalive while visible. The daemon keeps an in-memory
 * `Map<deviceId, { lastSeen, visible }>` (TTL ~45s), OR-aggregated per user, and
 * uses it to choose Toast over Push. Presence is ephemeral, never persisted —
 * a daemon restart empties the Map and safely over-pushes.
 *
 * Session-gated (NOT a `PUBLIC_PATH`): the reporter is the signed-in app, so
 * `locals.user` is set; a missing session 401s rather than redirecting. We
 * proxy over loopback with `x-friday-daemon-secret` via `withDaemon`.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = await request.json();
  return withDaemon((d) => d.post("/api/presence", body, { signal: request.signal }));
};
