import { json, type RequestHandler } from "@sveltejs/kit";
import { DAEMON_BASE, daemonAuthHeaders } from "$lib/server/daemon";
import { withDaemon } from "$lib/server/with-daemon";

const UPLOAD_TIMEOUT_MS = 60_000;

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const filename = request.headers.get("x-filename") ?? "upload";
  const contentType =
    request.headers.get("content-type") ?? "application/octet-stream";
  return withDaemon(async () => {
    const r = await fetch(`${DAEMON_BASE}/api/uploads`, {
      method: "POST",
      headers: {
        "content-type": contentType,
        "x-filename": filename,
        ...daemonAuthHeaders(),
      },
      body: request.body,
      // @ts-expect-error duplex is part of the spec but missing from the
      //   lib.dom typings shipped with TypeScript.
      duplex: "half",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!r.ok) {
      return json(await r.json().catch(() => ({ error: "upload failed" })), {
        status: r.status,
      });
    }
    return json(await r.json());
  });
};
