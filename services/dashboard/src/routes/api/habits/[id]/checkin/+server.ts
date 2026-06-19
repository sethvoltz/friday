import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  // Forward the parsed body (ts/note) so the daemon route can honor a
  // backdated `ts` / a `note`; an empty body is tolerated. Mirrors the
  // create proxy (../+server.ts), which does the same `await request.json()`.
  const body = await request.json().catch(() => ({}));
  return withDaemon((d) =>
    d.post(`/api/habits/${encodeURIComponent(params.id ?? "")}/checkin`, body, {
      signal: request.signal,
    }),
  );
};
