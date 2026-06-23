/**
 * FRI-142 (ADR-048), AC7 — contract test for `POST /api/push/forget-device`.
 *
 * Pins the "Forget this device" push-subscription cascade's dashboard hop:
 *   1. Session gate: a session-less caller gets a hard 401 and NOTHING is
 *      forwarded to the daemon.
 *   2. Body validation: a missing/blank `deviceId` 400s before any daemon call.
 *   3. Cross-boundary proxy: the daemon receives `{ deviceId, userId }` where
 *      `userId` is taken from the VERIFIED server session (`locals.user.id`),
 *      NOT from the client body — a client-supplied `userId` must be ignored.
 *      Forwarded over loopback to the daemon's `POST /api/push/forget-device`
 *      with the `x-friday-daemon-secret` header; the daemon response relays
 *      verbatim.
 *
 * We mock the real IO boundary (`global.fetch`) so the assertion exercises the
 * route → withDaemon → daemonPost → fetch chain and pins the forwarded URL +
 * secret header + body the daemon actually receives.
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

function event(opts: { user?: { id: string } | null; body?: unknown }): Parameters<typeof POST>[0] {
  const request = new Request("http://localhost/api/push/forget-device", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const user = "user" in opts ? opts.user : { id: "u1" };
  return { request, locals: { user } } as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/push/forget-device — session-gated daemon proxy", () => {
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
    const res = await POST(event({ user: null, body: { deviceId: "dev-X" } }));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("400s a missing deviceId and forwards nothing to the daemon", async () => {
    const res = await POST(event({ body: {} }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "deviceId is required" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards { deviceId, userId } using the SESSION userId (ignoring a client-supplied one) + daemon secret", async () => {
    const res = await POST(
      event({
        user: { id: "session-user" },
        // The client tries to spoof a different userId — it must be ignored.
        body: { deviceId: "dev-X", userId: "attacker-user" },
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAEMON_BASE}/api/push/forget-device`);
    expect(init.method).toBe("POST");
    // userId is the verified session id, never the client-supplied one.
    expect(JSON.parse(init.body as string)).toEqual({
      deviceId: "dev-X",
      userId: "session-user",
    });
    const headers = init.headers as Record<string, string>;
    expect(headers[DAEMON_SECRET_HEADER]).toBe(getDaemonSecret());
    expect(headers["content-type"]).toBe("application/json");
  });
});
