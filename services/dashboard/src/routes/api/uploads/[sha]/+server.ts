import { type RequestHandler } from "@sveltejs/kit";
import { DAEMON_BASE, daemonAuthHeaders } from "$lib/server/daemon";
import { withDaemon } from "$lib/server/with-daemon";

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const sha = params.sha;
  if (!sha || !/^[a-f0-9]{64}$/.test(sha)) {
    return new Response("bad request", { status: 400 });
  }
  return withDaemon(async () => {
    const r = await fetch(`${DAEMON_BASE}/api/uploads/${sha}`, {
      headers: daemonAuthHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return new Response("not found", { status: r.status });
    // Stream the body through; preserve the daemon's safety headers
    // (Content-Disposition for non-image attachments, X-Content-Type-Options:
    // nosniff, immutable cache-control) so the protective context can't be
    // dropped at this proxy layer.
    const passthrough: Record<string, string> = {
      "content-type": r.headers.get("content-type") ?? "application/octet-stream",
      "content-length": r.headers.get("content-length") ?? "",
      "cache-control": r.headers.get("cache-control") ?? "private, max-age=3600",
      "x-content-type-options":
        r.headers.get("x-content-type-options") ?? "nosniff",
    };
    const cd = r.headers.get("content-disposition");
    if (cd) passthrough["content-disposition"] = cd;
    return new Response(r.body, { status: 200, headers: passthrough });
  });
};
