import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = await request.json().catch(() => ({}));
  return withDaemon((d) =>
    d.post("/api/evolve/cluster", body, {
      signal: request.signal,
      timeoutMs: 60_000,
    }),
  );
};
