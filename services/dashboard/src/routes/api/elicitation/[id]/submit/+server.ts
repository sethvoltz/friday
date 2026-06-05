import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

// FRI-152: the AskUserQuestionPanel POSTs the user's structured answer
// here when they submit; we forward to the daemon's
// `POST /api/elicitation/<id>/submit` which fires the in-memory
// resolver for the worker's blocked MCP handler.
export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const id = params.id;
  if (!id) {
    return new Response(JSON.stringify({ error: "missing_id" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  return withDaemon((d) =>
    d.post<unknown>(`/api/elicitation/${encodeURIComponent(id)}/submit`, body, {
      signal: request.signal,
    }),
  );
};
