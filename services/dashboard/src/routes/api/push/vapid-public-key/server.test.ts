/**
 * FRI-142 (ADR-048) — contract test for `GET /api/push/vapid-public-key`.
 *
 * Pins:
 *   1. Session gate — a session-less caller gets 401 and nothing is fetched.
 *   2. Cross-boundary proxy — a GET is forwarded to the daemon's loopback
 *      `GET /api/push/vapid-public-key` carrying the `x-friday-daemon-secret`
 *      header, and the daemon's `{ publicKey }` response is relayed verbatim.
 *      Only the PUBLIC key is ever served — the private key never leaves the
 *      daemon.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  DAEMON_SECRET_HEADER,
  getDaemonSecret,
  loadConfig,
  resolveDaemonPort,
} from "@friday/shared";

const DAEMON_BASE = `http://127.0.0.1:${resolveDaemonPort(loadConfig())}`;
const { GET } = await import("./+server.js");

function event(opts: { user?: { id: string } | null }): Parameters<typeof GET>[0] {
  const request = new Request("http://localhost/api/push/vapid-public-key", { method: "GET" });
  const user = "user" in opts ? opts.user : { id: "u1" };
  return { request, locals: { user } } as unknown as Parameters<typeof GET>[0];
}

describe("GET /api/push/vapid-public-key — session-gated daemon proxy", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ publicKey: "BPublicKeyUrlSafeBase64" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("401s a session-less caller and fetches nothing", async () => {
    const res = await GET(event({ user: null }));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("relays the daemon's public key and carries the daemon secret", async () => {
    const res = await GET(event({}));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ publicKey: "BPublicKeyUrlSafeBase64" });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAEMON_BASE}/api/push/vapid-public-key`);
    const headers = init.headers as Record<string, string>;
    expect(headers[DAEMON_SECRET_HEADER]).toBe(getDaemonSecret());
  });
});
