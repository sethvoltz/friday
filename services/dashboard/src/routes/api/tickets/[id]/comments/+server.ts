import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = await request.json();
  // The author defaults to the signed-in user. The daemon doesn't know which
  // browser session sent the comment, so we stamp it here.
  const author =
    typeof body.author === "string" && body.author.trim()
      ? body.author
      : locals.user.name || locals.user.email;
  return withDaemon((d) =>
    d.post(
      `/api/tickets/${encodeURIComponent(params.id ?? "")}/comments`,
      { author, body: body.body },
      { signal: request.signal },
    ),
  );
};
