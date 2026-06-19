import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const GET: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  return withDaemon((d) =>
    d.get(`/api/habits/${encodeURIComponent(params.id ?? "")}`, {
      signal: request.signal,
    }),
  );
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = await request.json();
  return withDaemon((d) =>
    d.patch(`/api/habits/${encodeURIComponent(params.id ?? "")}`, body, {
      signal: request.signal,
    }),
  );
};
