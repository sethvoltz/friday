import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = await request.json().catch(() => ({}));
  // FRI-26 F15: the manual dashboard Scan button is signal-only by default — it
  // must NOT silently run the LLM-backed dreaming sub-pass (which auto-writes
  // memories + costs tokens). Only the nightly meta-agent opts in via the MCP
  // tool's `includeDreaming: true`. The daemon endpoint default stays true, so
  // default it to false HERE for the manual surface unless the caller asks.
  if ((body as { includeDreaming?: boolean }).includeDreaming === undefined) {
    (body as { includeDreaming?: boolean }).includeDreaming = false;
  }
  // Scan can take a while (friction signals scrape transcripts). Bump the
  // timeout so the UI doesn't see a fake daemon_timeout on a healthy run.
  return withDaemon((d) =>
    d.post("/api/evolve/scan", body, {
      signal: request.signal,
      timeoutMs: 120_000,
    }),
  );
};
