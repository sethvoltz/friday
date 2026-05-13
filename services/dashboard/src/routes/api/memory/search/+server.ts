import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const GET: RequestHandler = async ({ locals, request, url }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const qs = url.search || "";
  return withDaemon((d) =>
    d.get(`/api/memory/search${qs}`, { signal: request.signal }),
  );
};
