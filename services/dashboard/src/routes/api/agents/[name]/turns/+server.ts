import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const GET: RequestHandler = async ({ params, url, locals, request }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const limit = url.searchParams.get("limit") ?? "50";
  const before = url.searchParams.get("beforeId");
  const q = new URLSearchParams({ limit });
  if (before) q.set("beforeId", before);
  return withDaemon((d) =>
    d.get<unknown[]>(`/api/agents/${params.name}/turns?${q.toString()}`, {
      signal: request.signal,
    }),
  );
};
