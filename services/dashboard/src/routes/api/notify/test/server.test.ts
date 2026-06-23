/**
 * FRI-142 (ADR-048) — contract test for the `POST /api/notify/test` proxy.
 *
 * The "Send test notification" button in the Settings card POSTs here; the
 * route proxies over loopback to the daemon's Notification router
 * (`POST /api/notify/test`) so Seth can confirm the end-to-end push round-trip
 * on his installed PWA. Pins two load-bearing properties:
 *   1. Session gate: a session-less caller gets a hard 401 and NOTHING is
 *      forwarded to the daemon (the test trigger never fires unauthenticated).
 *   2. Cross-boundary proxy: on a valid session the route forwards an empty
 *      body to the daemon's loopback `POST /api/notify/test` carrying the
 *      `x-friday-daemon-secret` header, and relays the daemon's response.
 *
 * We mock the real IO boundary (`global.fetch`) rather than the daemon helper,
 * so the assertion exercises the route → withDaemon → daemonPost → fetch chain
 * and pins the forwarded URL + secret header + body the daemon receives.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  DAEMON_SECRET_HEADER,
  getDaemonSecret,
  loadConfig,
  resolveDaemonPort,
} from "@friday/shared";

const DAEMON_BASE = `http://127.0.0.1:${resolveDaemonPort(loadConfig())}`;
const { POST } = await import("./+server.js");

function event(opts: { user?: { id: string } | null }): Parameters<typeof POST>[0] {
  const request = new Request("http://localhost/api/notify/test", { method: "POST" });
  const user = "user" in opts ? opts.user : { id: "u1" };
  return { request, locals: { user } } as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/notify/test — session-gated daemon proxy", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, fired: ["toast"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("401s a session-less caller and forwards nothing to the daemon", async () => {
    const res = await POST(event({ user: null }));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards an empty body + daemon secret to the loopback daemon and relays the response", async () => {
    const res = await POST(event({}));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, fired: ["toast"] });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAEMON_BASE}/api/notify/test`);
    expect(init.method).toBe("POST");
    // The test trigger carries no payload — the daemon synthesizes the
    // builder_archive-class test event itself.
    expect(JSON.parse(init.body as string)).toEqual({});
    const headers = init.headers as Record<string, string>;
    expect(headers[DAEMON_SECRET_HEADER]).toBe(getDaemonSecret());
  });
});
