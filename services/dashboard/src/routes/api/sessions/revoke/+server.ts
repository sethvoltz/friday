import { json, type RequestHandler } from "@sveltejs/kit";
import { revokeSessionById } from "@friday/shared/services";

/**
 * Revoke a single BetterAuth session belonging to the authenticated user.
 * Body: `{ id: string }`. The current session is allowed to revoke itself
 * — the UI just redirects to /login afterward.
 *
 * FIX_FORWARD 5.11.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { id?: string };
  const id = body.id;
  if (!id || typeof id !== "string") {
    return json({ error: "missing id" }, { status: 400 });
  }
  const revoked = revokeSessionById(locals.user.id, id);
  return json({ ok: true, revoked });
};
