import { json, type RequestHandler } from "@sveltejs/kit";
import { daemonGet, DAEMON_BASE } from "$lib/server/daemon";

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  return json(await daemonGet(`/api/tickets/${params.id}`));
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = await request.json();
  const r = await fetch(`${DAEMON_BASE}/api/tickets/${params.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return new Response(r.body, { status: r.status });
};
