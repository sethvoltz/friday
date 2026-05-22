// WebSocket reverse-proxy used by `server-entry.mjs` in production.
//
// The dashboard owns the Cloudflare Tunnel ingress. zero-cache binds
// to 127.0.0.1:4848 and isn't reachable from outside the host. To get a
// browser on the user's phone talking to zero-cache, we accept WS
// upgrade requests on `/api/sync/*` against the dashboard's own
// origin and pipe them through to localhost.
//
// Factored out of `server-entry.mjs` so the upgrade handler is
// testable as a pure function (no listen, no env reads at import time).

import net from "node:net";

/**
 * The proxy mount path. Zero's `ZeroOptions.server` constraint:
 * "at most one path component" — `https://friday.voltzmakes.com/api/sync`
 * is rejected at construction time with
 *
 *   Error: ZeroOptions.server may have at most one path component.
 *   For example: "https://myapp-myteam.zero.ms/zero".
 *
 * so the mount has to be a single segment. With `server` set to
 * `${origin}/zero` the client opens `/zero/sync/v50/connect`; we strip
 * `/zero` and forward `/sync/v50/connect` to zero-cache. (The
 * unauthenticated HTTP endpoints around it — `/api/sync/refresh` for
 * JWT mint, `/api/_diag/client-error` for client-side error
 * reporting — keep their two-component paths; they're plain SvelteKit
 * routes, not Zero's server URL.)
 */
export const PROXY_PREFIX = "/zero";

/**
 * Build an upgrade-event listener for an HTTP server that proxies
 * `${PROXY_PREFIX}/*` upgrades to the given upstream and refuses the
 * rest with a clean 400.
 *
 * @param {{
 *   upstreamHost: string,
 *   upstreamPort: number,
 *   debug?: boolean,
 *   log?: (event: string, payload: Record<string, unknown>) => void,
 * }} opts
 * @returns {(req: import("node:http").IncomingMessage, socket: import("node:net").Socket, head: Buffer) => void}
 */
export function createZeroUpgradeHandler(opts) {
  const { upstreamHost, upstreamPort, debug = false, log } = opts;
  /** @type {(event: string, payload: Record<string, unknown>) => void} */
  const logEvent = log ?? (() => {});
  return function onUpgrade(req, clientSocket, head) {
    const url = req.url ?? "";
    const remoteAddr =
      req.socket?.remoteAddress ??
      clientSocket.remoteAddress ??
      "unknown";
    const fwd = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"];
    if (!url.startsWith(PROXY_PREFIX + "/") && url !== PROXY_PREFIX) {
      // Some other route's WS upgrade; we don't know how to serve it.
      // Return a clean 400 so the client sees a refusal, not a hang.
      logEvent("zero-proxy.upgrade.rejected", {
        url,
        reason: "path_outside_mount",
        remote: remoteAddr,
        forwardedFor: typeof fwd === "string" ? fwd : null,
      });
      clientSocket.write(
        "HTTP/1.1 400 Bad Request\r\n" +
          "Connection: close\r\n" +
          "Content-Length: 0\r\n" +
          "\r\n",
      );
      clientSocket.destroy();
      return;
    }
    logEvent("zero-proxy.upgrade.accepted", {
      url,
      remote: remoteAddr,
      forwardedFor: typeof fwd === "string" ? fwd : null,
      userAgent: req.headers["user-agent"] ?? null,
    });

    // Strip the mount path. zero-cache expects `/sync/v50/...` at its root.
    const targetPath = url.slice(PROXY_PREFIX.length) || "/";

    const upstream = net.connect(upstreamPort, upstreamHost);

    let torndown = false;
    /** @type {(where: string, err?: Error) => void} */
    const teardown = (where, err) => {
      if (torndown) return;
      torndown = true;
      try {
        upstream.destroy();
      } catch {
        /* already destroyed */
      }
      try {
        clientSocket.destroy();
      } catch {
        /* already destroyed */
      }
      if (err && debug) {
         
        console.error(`[zero-proxy] ${where} error:`, err.message);
      }
    };

    upstream.on("connect", () => {
      // Rewrite the upgrade request line + headers and replay them
      // verbatim to zero-cache. We do NOT touch the Host header:
      // upgrade tokens, the WebSocket key, and any auth-bearing query
      // params already point at the correct path now that we've
      // stripped the prefix.
      const headerLines = [];
      for (const [name, value] of Object.entries(req.headers)) {
        if (value == null) continue;
        if (Array.isArray(value)) {
          for (const v of value) headerLines.push(`${name}: ${v}`);
        } else {
          headerLines.push(`${name}: ${value}`);
        }
      }
      const requestHead =
        `${req.method} ${targetPath} HTTP/${req.httpVersion}\r\n` +
        headerLines.join("\r\n") +
        "\r\n\r\n";
      upstream.write(requestHead);
      if (head && head.length > 0) upstream.write(head);

      // Bidirectional byte pipe. We deliberately don't parse the 101
      // response — Node's net stream is symmetric once both sides
      // have switched protocols, and pre-101 framing already lives
      // in the request/response bytes themselves.
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on("error", (err) => {
      logEvent("zero-proxy.upstream.error", {
        url,
        message: err.message,
        // `Error` doesn't carry `code` in the standard type, but
        // node's `net` errors are augmented with one
        // (`ECONNREFUSED`, `ETIMEDOUT`, …). Read through `unknown`
        // to satisfy strict mode without losing the value.
        code: /** @type {{code?: string}} */ (
          /** @type {unknown} */ (err)
        ).code ?? null,
      });
      teardown("upstream", err);
    });
    clientSocket.on("error", (err) => teardown("client", err));
    upstream.on("close", () =>
      teardown("upstream-close"),
    );
    clientSocket.on("close", () => teardown("client-close"));
  };
}
