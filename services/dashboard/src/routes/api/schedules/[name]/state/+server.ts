import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const GET: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  return withDaemon((d) =>
    d.get(`/api/schedules/${encodeURIComponent(params.name ?? "")}/state`, {
      signal: request.signal,
    }),
  );
};
