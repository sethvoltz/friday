import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  return withDaemon((d) =>
    d.post(
      `/api/schedules/${encodeURIComponent(params.name ?? "")}/pause`,
      {},
      { signal: request.signal },
    ),
  );
};
