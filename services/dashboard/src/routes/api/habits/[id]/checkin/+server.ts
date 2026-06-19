import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  // Forward the parsed body (ts/note) — an empty body is tolerated. The
  // create proxy (../+server.ts) does the same `await request.json()`; the
  // earlier hardcoded `{}` silently dropped backdate ts and notes.
  const body = await request.json().catch(() => ({}));
  return withDaemon((d) =>
    d.post(`/api/habits/${encodeURIComponent(params.id ?? "")}/checkin`, body, {
      signal: request.signal,
    }),
  );
};
