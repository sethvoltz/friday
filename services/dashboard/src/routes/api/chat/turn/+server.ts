import { json, type RequestHandler } from "@sveltejs/kit";
import { daemonPost } from "$lib/server/daemon";

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = await request.json();
  const r = await daemonPost<{ turn_id: string }>("/api/chat/turn", body);
  return json(r);
};
