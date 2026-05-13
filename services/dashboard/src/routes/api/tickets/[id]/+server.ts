import { type RequestHandler } from "@sveltejs/kit";
import { DAEMON_BASE, daemonAuthHeaders } from "$lib/server/daemon";
import { withDaemon } from "$lib/server/with-daemon";

export const GET: RequestHandler = async ({ params, locals, request }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  return withDaemon((d) =>
    d.get(`/api/tickets/${params.id}`, { signal: request.signal }),
  );
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = await request.json();
  return withDaemon(async () => {
    const r = await fetch(`${DAEMON_BASE}/api/tickets/${params.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...daemonAuthHeaders() },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    return new Response(r.body, { status: r.status });
  });
};
