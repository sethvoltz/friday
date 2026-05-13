import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = await request.json().catch(() => ({}));
  // Enrichment fires a Sonnet call per pending proposal; comfortably long
  // timeout. Bulk enrich runs sequentially server-side.
  return withDaemon((d) =>
    d.post("/api/evolve/enrich", body, {
      signal: request.signal,
      timeoutMs: 300_000,
    }),
  );
};
