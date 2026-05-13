import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

/**
 * Proxy to the daemon's `GET /api/agents/:name`. Returns the registry's
 * `AgentEntry`. Used by `loadAgentTurns` to probe agent status on reload
 * so `chat.inflightTurnId` can be restored when the daemon is still
 * mid-turn.
 */
export const GET: RequestHandler = async ({ params, locals, request }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  return withDaemon((d) =>
    d.get<unknown>(`/api/agents/${encodeURIComponent(params.name ?? "")}`, {
      signal: request.signal,
    }),
  );
};
