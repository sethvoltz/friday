import { type RequestHandler } from "@sveltejs/kit";
import { DAEMON_BASE } from "$lib/server/daemon";

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const sha = params.sha;
  if (!sha || !/^[a-f0-9]{64}$/.test(sha)) {
    return new Response("bad request", { status: 400 });
  }
  const r = await fetch(`${DAEMON_BASE}/api/uploads/${sha}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) return new Response("not found", { status: r.status });
  // Stream the body through; the daemon already set content-type and
  // immutable cache-control on a content-addressed URL.
  return new Response(r.body, {
    status: 200,
    headers: {
      "content-type": r.headers.get("content-type") ?? "application/octet-stream",
      "content-length": r.headers.get("content-length") ?? "",
      "cache-control": r.headers.get("cache-control") ?? "private, max-age=3600",
    },
  });
};
