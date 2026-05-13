import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

/**
 * Proxy to the daemon's `GET /api/agents/:name/blocks`. The dashboard's
 * chat store reads its entire history through this endpoint
 * (FIX_FORWARD post-WS-1 → `blocks` is the canonical table). Forwards
 * the full querystring untouched so `limit` / `before` / `after` /
 * `around_ts` / `match` / `session_id` / `before_limit` / `after_limit`
 * all pass through.
 */
export const GET: RequestHandler = async ({ params, url, locals, request }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const qs = url.search || "";
  return withDaemon((d) =>
    d.get<unknown>(
      `/api/agents/${encodeURIComponent(params.name ?? "")}/blocks${qs}`,
      { signal: request.signal },
    ),
  );
};
