import { json, type RequestHandler } from "@sveltejs/kit";
import { daemonGet, daemonPost } from "$lib/server/daemon";

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  return json(await daemonGet("/api/commands"));
};

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = await request.json();
  return json(await daemonPost("/api/commands/dispatch", body));
};
