/**
 * Cross-boundary test for the `/api/sync` WebSocket reverse-proxy that
 * fronts zero-cache (see `services/dashboard/server-entry-proxy.mjs`).
 *
 * The proxy is the only thing between a phone over Cloudflare Tunnel
 * and a zero-cache bound to 127.0.0.1:4848. Per CLAUDE.md:
 *   "Cross-boundary code needs a cross-boundary test."
 *
 * These tests pipe real TCP bytes: a fake upstream listens on an
 * ephemeral port and records the first chunk it receives (the
 * rewritten HTTP upgrade request); a fake client opens a raw socket
 * to an HTTP server wired with the proxy's upgrade handler and
 * exchanges WS-handshake-style bytes. Assertions pin specific bytes
 * (the rewritten request line, the strip of `/api/sync` from the
 * path, byte-level echo in both directions), not types.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import http from "node:http";
import net from "node:net";
// vitest evaluates .test.ts under vite, which can import the sibling
// `.mjs` server-entry from the package root via a relative path.
// @ts-expect-error: .mjs has no .d.ts; this module exports plain JS.
import { createZeroUpgradeHandler, PROXY_PREFIX } from "../../../server-entry-proxy.mjs";

interface Harness {
  proxyPort: number;
  proxyServer: http.Server;
  upstreamPort: number;
  upstreamServer: net.Server;
  /** First chunk the upstream received per accepted connection. */
  upstreamFirstChunks: Buffer[];
  /** Additional bytes received by upstream after the first chunk. */
  upstreamLaterBytes: Buffer[];
  /** Sockets the upstream is currently holding open. */
  upstreamSockets: net.Socket[];
}

async function buildHarness(): Promise<Harness> {
  const upstreamFirstChunks: Buffer[] = [];
  const upstreamLaterBytes: Buffer[] = [];
  const upstreamSockets: net.Socket[] = [];

  // Fake upstream: capture the first chunk (proxied request head)
  // and any subsequent bytes (proxied client traffic), echo back
  // any bytes prefixed with "ECHO:" so we can assert downstream
  // pipe correctness.
  const upstreamServer = net.createServer((socket) => {
    upstreamSockets.push(socket);
    let receivedFirst = false;
    socket.on("data", (chunk) => {
      if (!receivedFirst) {
        upstreamFirstChunks.push(chunk);
        receivedFirst = true;
      } else {
        upstreamLaterBytes.push(chunk);
        if (chunk.subarray(0, 5).toString() === "ECHO:") {
          socket.write(chunk.subarray(5));
        }
      }
    });
  });
  await new Promise<void>((resolve) =>
    upstreamServer.listen(0, "127.0.0.1", resolve),
  );
  const upstreamPort = (upstreamServer.address() as net.AddressInfo).port;

  // Proxy: an HTTP server (request handler returns 404 because
  // we're only exercising the upgrade path) with the proxy's
  // upgrade listener attached.
  const proxyServer = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  proxyServer.on(
    "upgrade",
    createZeroUpgradeHandler({
      upstreamHost: "127.0.0.1",
      upstreamPort,
    }),
  );
  await new Promise<void>((resolve) =>
    proxyServer.listen(0, "127.0.0.1", resolve),
  );
  const proxyPort = (proxyServer.address() as net.AddressInfo).port;

  return {
    proxyPort,
    proxyServer,
    upstreamPort,
    upstreamServer,
    upstreamFirstChunks,
    upstreamLaterBytes,
    upstreamSockets,
  };
}

async function closeHarness(h: Harness): Promise<void> {
  for (const s of h.upstreamSockets) s.destroy();
  await new Promise<void>((resolve) => h.proxyServer.close(() => resolve()));
  await new Promise<void>((resolve) => h.upstreamServer.close(() => resolve()));
}

/** Open a raw TCP socket to (host, port) and resolve once connected. */
function rawConnect(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

/** Collect bytes from a socket until `predicate(buf)` returns true. */
function readUntil(
  socket: net.Socket,
  predicate: (buf: Buffer) => boolean,
  timeoutMs = 1000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error(`readUntil timed out; got ${buf.length} bytes so far`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (predicate(buf)) {
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(buf);
      }
    };
    socket.on("data", onData);
  });
}

/** Sleep for the given millis. Used sparingly where we need to
 *  observe absence of data, not its presence. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createZeroUpgradeHandler", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    await closeHarness(h);
  });

  test(
    "upgrade on /api/sync/sync/v50/connect arrives at upstream with /api/sync stripped from request line",
    async () => {
      const client = await rawConnect("127.0.0.1", h.proxyPort);
      const upgradeReq =
        "GET /api/sync/sync/v50/connect?clientID=abc HTTP/1.1\r\n" +
        "Host: dashboard.local\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "\r\n";
      client.write(upgradeReq);

      // Wait until the upstream observes the proxied head. Polling
      // here is fine — the proxy runs in the same event loop and
      // the byte-count test below resolves as soon as it arrives.
      for (let i = 0; i < 50 && h.upstreamFirstChunks.length === 0; i++) {
        await sleep(10);
      }
      expect(h.upstreamFirstChunks.length).toBe(1);
      const proxied = h.upstreamFirstChunks[0]!.toString();

      // Request line: prefix stripped, query string preserved, HTTP
      // version preserved.
      expect(proxied.startsWith("GET /sync/v50/connect?clientID=abc HTTP/1.1\r\n")).toBe(true);

      // Headers preserved verbatim — these are exactly what zero-cache
      // needs to honor the WS handshake.
      expect(proxied).toContain("\r\nupgrade: websocket\r\n");
      expect(proxied).toContain("\r\nconnection: Upgrade\r\n");
      expect(proxied).toContain("\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n");
      expect(proxied).toContain("\r\nsec-websocket-version: 13\r\n");

      client.destroy();
    },
  );

  test(
    "bytes flow client→upstream and upstream→client after the upgrade handshake",
    async () => {
      const client = await rawConnect("127.0.0.1", h.proxyPort);
      client.write(
        "GET /api/sync/sync/v50/connect HTTP/1.1\r\n" +
          "Host: dashboard.local\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "\r\n",
      );

      // Wait for upstream to register the connection.
      for (let i = 0; i < 50 && h.upstreamSockets.length === 0; i++) {
        await sleep(10);
      }
      expect(h.upstreamSockets.length).toBe(1);

      // Client → upstream. The fake upstream's data handler stores
      // post-first-chunk bytes in `upstreamLaterBytes`.
      client.write("HELLO-FROM-CLIENT");
      for (let i = 0; i < 50 && h.upstreamLaterBytes.length === 0; i++) {
        await sleep(10);
      }
      expect(Buffer.concat(h.upstreamLaterBytes).toString()).toBe("HELLO-FROM-CLIENT");

      // Upstream → client. The fake upstream's echo path responds to
      // payloads prefixed `ECHO:` — write one and read it back through
      // the proxy.
      client.write("ECHO:WS-FRAME-BYTES");
      const echoed = await readUntil(
        client,
        (buf) => buf.toString().includes("WS-FRAME-BYTES"),
      );
      expect(echoed.toString()).toBe("WS-FRAME-BYTES");

      client.destroy();
    },
  );

  test("upgrade on path outside /api/sync is refused with HTTP 400 and no upstream connection", async () => {
    const client = await rawConnect("127.0.0.1", h.proxyPort);
    client.write(
      "GET /api/some-other-route HTTP/1.1\r\n" +
        "Host: dashboard.local\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "\r\n",
    );

    // The proxy should answer the upgrade with 400 and close the
    // socket. Read the response head.
    const buf = await readUntil(client, (b) => b.includes("\r\n\r\n"));
    expect(buf.toString().startsWith("HTTP/1.1 400 Bad Request\r\n")).toBe(true);

    // And — critically — no upstream connection was opened for the
    // refused path. The proxy must not contact zero-cache when the
    // path doesn't match its mount prefix.
    await sleep(50);
    expect(h.upstreamSockets.length).toBe(0);

    client.destroy();
  });

  test("PROXY_PREFIX is the documented mount path Zero clients can target", () => {
    expect(PROXY_PREFIX).toBe("/api/sync");
  });
});
