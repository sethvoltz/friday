import { json, type RequestHandler } from "@sveltejs/kit";
import { daemonGet } from "$lib/server/daemon";

export const GET: RequestHandler = async ({ params, url, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const limit = url.searchParams.get("limit") ?? "200";
  const turns = await daemonGet<unknown[]>(
    `/api/sessions/${params.id}/turns?limit=${limit}`,
  );
  return json(turns);
};
