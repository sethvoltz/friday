import { json, type RequestHandler } from "@sveltejs/kit";
import { daemonGet } from "$lib/server/daemon";

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const agents = await daemonGet<unknown[]>("/api/agents");
  return json(agents);
};
