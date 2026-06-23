/**
 * FRI-142 (ADR-048) — contract test for the `POST /api/push/subscribe` proxy.
 *
 * Pins two load-bearing properties:
 *   1. Session gate: a session-less caller gets a hard 401 and NOTHING is
 *      forwarded to the daemon (no row write attempted).
 *   2. Cross-boundary proxy: on a valid session the `PushSubscribePayload` is
 *      forwarded to the daemon's loopback `POST /api/push/subscribe` with the
 *      verified session `userId` stamped on — same URL, body =
 *      `{ ...PAYLOAD, userId }`, carrying the `x-friday-daemon-secret` header —
 *      and the daemon's response is relayed verbatim. The `userId` MUST come
 *      from `locals.user.id`, not the client body (the daemon 400s without it).
 *
 * We mock the real IO boundary (`global.fetch`) rather than the daemon helper,
 * so the assertion exercises the route → withDaemon → daemonPost → fetch chain
 * and can pin the forwarded URL + secret header + body that the daemon
 * actually receives.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  DAEMON_SECRET_HEADER,
  getDaemonSecret,
  loadConfig,
  resolveDaemonPort,
} from "@friday/shared";
import type { PushSubscribePayload } from "@friday/shared";

const DAEMON_BASE = `http://127.0.0.1:${resolveDaemonPort(loadConfig())}`;
const { POST } = await import("./+server.js");

function event(opts: { user?: { id: string } | null; body?: unknown }): Parameters<typeof POST>[0] {
  const request = new Request("http://localhost/api/push/subscribe", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const user = "user" in opts ? opts.user : { id: "u1" };
  return { request, locals: { user } } as unknown as Parameters<typeof POST>[0];
}

const PAYLOAD: PushSubscribePayload = {
  endpoint: "https://web.push.apple.com/abc123",
  keys: { p256dh: "p256dh-key", auth: "auth-secret" },
  deviceId: "device-42",
};

describe("POST /api/push/subscribe — session-gated daemon proxy", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("401s a session-less caller and forwards nothing to the daemon", async () => {
    const res = await POST(event({ user: null, body: PAYLOAD }));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards the exact payload + daemon secret to the loopback daemon and relays the response", async () => {
    const res = await POST(event({ body: PAYLOAD }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAEMON_BASE}/api/push/subscribe`);
    expect(init.method).toBe("POST");
    // Forwarded body = the client payload + the verified session userId
    // (from locals.user.id, NOT the client body). Without userId the daemon
    // 400s and no push_subscriptions row is written.
    expect(JSON.parse(init.body as string)).toEqual({ ...PAYLOAD, userId: "u1" });
    // The same-host shared secret rides the proxied request.
    const headers = init.headers as Record<string, string>;
    expect(headers[DAEMON_SECRET_HEADER]).toBe(getDaemonSecret());
    expect(headers["content-type"]).toBe("application/json");
  });
});
