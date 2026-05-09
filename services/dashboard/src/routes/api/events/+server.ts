import type { RequestHandler } from "@sveltejs/kit";
import { loadConfig } from "@friday/shared";

/**
 * Pipe the daemon's SSE stream to the browser using a fresh ReadableStream
 * that explicitly enqueues each chunk. Going through `fetch` + `Response(body)`
 * has buffering issues in vite dev — so we drive the stream ourselves and
 * make sure each chunk is flushed.
 */
export const GET: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });

  const cfg = loadConfig();
  const headers: Record<string, string> = {};
  const lastId = request.headers.get("last-event-id");
  if (lastId) headers["last-event-id"] = lastId;

  const upstream = await fetch(
    `http://localhost:${cfg.daemonPort}/api/events`,
    { headers, signal: request.signal },
  );

  if (!upstream.body) {
    return new Response("upstream has no body", { status: 502 });
  }

  const reader = upstream.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      void reader.cancel();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
};
