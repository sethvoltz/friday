import { json, type RequestHandler } from "@sveltejs/kit";
import { daemonPost } from "$lib/server/daemon";

export const POST: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const r = await daemonPost(`/api/chat/turn/${params.id}/abort`, {});
  return json(r);
};
