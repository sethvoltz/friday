import { json, type RequestHandler } from "@sveltejs/kit";
import { revokeAllSessionsForUser } from "@friday/shared/services";

/**
 * Revoke every BetterAuth session belonging to the authenticated user,
 * including the current one. The caller is expected to redirect to
 * /login immediately afterward.
 *
 * FIX_FORWARD 5.11.
 */
export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const revoked = revokeAllSessionsForUser(locals.user.id);
  return json({ ok: true, revoked });
};
