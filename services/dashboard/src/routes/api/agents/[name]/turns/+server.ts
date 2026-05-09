import { json, type RequestHandler } from "@sveltejs/kit";
import { daemonGet } from "$lib/server/daemon";

export const GET: RequestHandler = async ({ params, url, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const limit = url.searchParams.get("limit") ?? "50";
  const before = url.searchParams.get("beforeId");
  const q = new URLSearchParams({ limit });
  if (before) q.set("beforeId", before);
  const turns = await daemonGet<unknown[]>(
    `/api/agents/${params.name}/turns?${q.toString()}`,
  );
  return json(turns);
};
