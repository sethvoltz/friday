import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const GET: RequestHandler = async ({ locals, request, url }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const qs = url.search ? url.search : "";
  return withDaemon((d) =>
    d.get(`/api/evolve/proposals${qs}`, { signal: request.signal }),
  );
};
