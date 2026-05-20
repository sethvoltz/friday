import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

// Phase 4.9 fast-path proxy. The dashboard's `cancelQueued` wrapper
// posts here with `{ block_id }`; we forward to the daemon's
// `POST /api/internal/cancel-queued` which synchronously splices the
// worker's `nextPrompts` deque. Idempotent: if the LISTEN-path (the
// Zero mutator + Postgres trigger) already deleted the row, the
// daemon returns 200 with `already_canceled=true`.
//
// Authenticated callers only. The daemon enforces its own loopback +
// shared-secret check; this layer enforces the session.
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = (await request.json().catch(() => ({}))) as {
    block_id?: unknown;
  };
  if (typeof body.block_id !== "string") {
    return new Response(JSON.stringify({ error: "missing_block_id" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  return withDaemon((d) =>
    d.post<unknown>(
      "/api/internal/cancel-queued",
      { block_id: body.block_id },
      { signal: request.signal },
    ),
  );
};
