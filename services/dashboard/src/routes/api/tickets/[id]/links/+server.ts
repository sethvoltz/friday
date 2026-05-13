import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = await request.json();
  return withDaemon((d) =>
    d.post(
      `/api/tickets/${encodeURIComponent(params.id ?? "")}/links`,
      body,
      { signal: request.signal },
    ),
  );
};

export const DELETE: RequestHandler = async ({ params, url, request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const system = url.searchParams.get("system");
  const externalId = url.searchParams.get("externalId");
  if (!system || !externalId) {
    return new Response("system and externalId query params required", {
      status: 400,
    });
  }
  const qs = `?system=${encodeURIComponent(system)}&externalId=${encodeURIComponent(externalId)}`;
  return withDaemon((d) =>
    d.del(
      `/api/tickets/${encodeURIComponent(params.id ?? "")}/links${qs}`,
      { signal: request.signal },
    ),
  );
};
