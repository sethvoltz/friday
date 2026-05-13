import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = await request.json().catch(() => ({}));
  // Scan can take a while (friction signals scrape transcripts). Bump the
  // timeout so the UI doesn't see a fake daemon_timeout on a healthy run.
  return withDaemon((d) =>
    d.post("/api/evolve/scan", body, {
      signal: request.signal,
      timeoutMs: 120_000,
    }),
  );
};
