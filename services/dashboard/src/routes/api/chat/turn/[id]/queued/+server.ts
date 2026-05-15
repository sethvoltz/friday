import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

// Cancel a queued user-chat turn before the worker dispatches it. The
// daemon deletes the user block, removes the entry from `nextPrompts`,
// emits a `block_meta_update` with status='aborted' (so other tabs drop
// their queued bubble), and returns the recovered prompt text so the
// dashboard can stuff it back into the input bar.
export const DELETE: RequestHandler = async ({ params, locals, request }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  return withDaemon((d) =>
    d.del(`/api/chat/turn/${params.id}/queued`, {
      signal: request.signal,
    }),
  );
};
