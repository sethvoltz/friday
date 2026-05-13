import { json, type RequestHandler } from "@sveltejs/kit";
import { resetRateLimitPrefix } from "@friday/shared/services";

/**
 * Wipe every active auth-related rate-limit bucket (FIX_FORWARD 6.3).
 * Gated behind a confirmation modal on the Settings page — surfaced for
 * the edge case where a user's IP is locked out for 30 minutes and the
 * operator wants to unlock it before the window expires.
 */
export const POST: RequestHandler = ({ locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const cleared = resetRateLimitPrefix("auth:");
  return json({ ok: true, cleared });
};
