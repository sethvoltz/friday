import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const POST: RequestHandler = async ({ params, locals, request }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  return withDaemon((d) =>
    d.post<unknown>(
      `/api/apps/${encodeURIComponent(params.id ?? "")}/reload`,
      {},
      { signal: request.signal },
    ),
  );
};
