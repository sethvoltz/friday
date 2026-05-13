import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = await request.json().catch(() => ({}));
  return withDaemon((d) =>
    d.post(
      `/api/evolve/proposals/${encodeURIComponent(params.id ?? "")}/dismiss`,
      body,
      { signal: request.signal },
    ),
  );
};
