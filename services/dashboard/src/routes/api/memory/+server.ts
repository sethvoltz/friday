import { type RequestHandler } from "@sveltejs/kit";
import { withDaemon } from "$lib/server/with-daemon";

export const GET: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  return withDaemon((d) =>
    d.get("/api/memory", { signal: request.signal }),
  );
};

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = await request.json();
  return withDaemon((d) =>
    d.post("/api/memory", body, { signal: request.signal }),
  );
};
