import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

// Phase 4.10 fast-path proxy. The dashboard's `abortTurn` wrapper
// posts here with `{ turn_id }`; we forward to the daemon's
// `POST /api/internal/abort-turn` which synchronously fires the
// worker's AbortController. Idempotent: the LISTEN-path (the Zero
// mutator + Postgres trigger) calls the same lifecycle abortTurn,
// so dispatching both is safe.
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = (await request.json().catch(() => ({}))) as {
    turn_id?: unknown;
  };
  if (typeof body.turn_id !== "string") {
    return new Response(JSON.stringify({ error: "missing_turn_id" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  return withDaemon((d) =>
    d.post<unknown>(
      "/api/internal/abort-turn",
      { turn_id: body.turn_id },
      { signal: request.signal },
    ),
  );
};
