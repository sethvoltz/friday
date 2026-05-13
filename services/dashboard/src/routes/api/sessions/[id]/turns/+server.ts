import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const GET: RequestHandler = async ({ params, url, locals, request }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const limit = url.searchParams.get("limit") ?? "200";
  return withDaemon((d) =>
    d.get<unknown[]>(`/api/sessions/${params.id}/turns?limit=${limit}`, {
      signal: request.signal,
    }),
  );
};
