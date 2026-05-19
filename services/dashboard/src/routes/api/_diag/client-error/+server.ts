/**
 * Diagnostic endpoint: client-side error reporter.
 *
 * The dashboard JSONL log is the only side-band a phone PWA has when
 * the user can't open DevTools. The Zero store posts here when it
 * lands in `status = "error"` so the underlying message is visible
 * to a `friday logs dashboard -f` watcher without needing the user's
 * cooperation. Authenticated path — anonymous reporters would let
 * the public internet flood the log file.
 */

import type { RequestHandler } from "@sveltejs/kit";
import { logger } from "$lib/server/log";

interface ClientErrorPayload {
  event: string;
  message?: string;
  stack?: string;
  url?: string;
  userAgent?: string;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  let payload: ClientErrorPayload;
  try {
    payload = (await request.json()) as ClientErrorPayload;
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  logger.log("warn", `client.${payload.event ?? "unknown"}`, {
    userId: locals.user.id,
    message: payload.message ?? null,
    stack: payload.stack ?? null,
    url: payload.url ?? null,
    userAgent: payload.userAgent ?? request.headers.get("user-agent") ?? null,
  });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
