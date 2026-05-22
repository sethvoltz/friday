// Production dashboard entry that wraps SvelteKit/adapter-node's handler
// with a WebSocket reverse-proxy for Zero sync traffic.
//
// Why this exists: zero-cache binds to 127.0.0.1:4848 (local-only) and
// the Cloudflare Tunnel only routes the dashboard's HTTPS origin.
// Without proxying, the browser bundle's Zero client (which opens a WS
// to `<server>/sync/v50/connect`) is unreachable from any device that
// isn't the dashboard host. Exposing zero-cache via a second tunnel
// route would split the cookie/CSRF surface and need a separate
// hostname; piping `/api/sync/*` upgrades to localhost:4848 over the
// existing origin avoids both costs.
//
// This replaces adapter-node's default `build/index.js` only as the
// process entrypoint. The polka handler (`build/handler.js`) is still
// the source of truth for everything except WS upgrades — we mount it
// as the `request` listener and only intercept `upgrade` events whose
// URL starts with `/api/sync`. Non-matching upgrades are destroyed
// (returning 400 to the client) so we don't accidentally proxy unrelated
// upgrade attempts.

import http from "node:http";
import process from "node:process";

const { handler } = await import("./build/handler.js");
const { createZeroUpgradeHandler, PROXY_PREFIX } = await import(
  "./server-entry-proxy.mjs"
);

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const ZERO_CACHE_HOST = process.env.ZERO_CACHE_HOST ?? "127.0.0.1";
const ZERO_CACHE_PORT = Number(process.env.ZERO_CACHE_PORT ?? 4848);

// Tag each WS-proxy event with the dashboard service so it shows up
// next to the request log lines under the same JSONL stream the user
// already greps for in `~/.friday/logs/dashboard.jsonl`. Stdout in the
// tmux session works as the destination — the friday CLI's `logs`
// command tails the JSONL file the polka request hook already writes
// to, and prepending these to that surface kept-the-debug-loop-tight
// concerns simple.
function emitProxyLog(event, payload) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    service: "dashboard",
    event,
    ...payload,
  });
   
  console.log(line);
}

const server = http.createServer(handler);
server.on(
  "upgrade",
  createZeroUpgradeHandler({
    upstreamHost: ZERO_CACHE_HOST,
    upstreamPort: ZERO_CACHE_PORT,
    debug: !!process.env.DEBUG_ZERO_PROXY,
    log: emitProxyLog,
  }),
);

server.listen(PORT, HOST, () => {
  console.log(
    `Dashboard listening on http://${HOST}:${PORT} (zero-proxy → ${ZERO_CACHE_HOST}:${ZERO_CACHE_PORT}${PROXY_PREFIX}/*)`,
  );
});

function shutdown(signal) {
  console.log(`Received ${signal} — shutting down`);
  server.close(() => process.exit(0));
  // Hard deadline matches adapter-node's default.
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
