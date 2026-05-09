import { json, type RequestHandler } from "@sveltejs/kit";
import { daemonGet } from "$lib/server/daemon";

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const sessions = await daemonGet<unknown[]>(
    `/api/agents/${params.name}/sessions`,
  );
  return json(sessions);
};
