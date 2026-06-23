/**
 * FRI-142 (ADR-048) — contract test for the `POST /api/presence` proxy.
 *
 * Pins:
 *   1. Session gate — a session-less caller gets 401 and nothing is forwarded.
 *   2. Cross-boundary proxy — the `PresenceReport` is forwarded to the daemon's
 *      loopback `POST /api/presence` EXACTLY (same URL, body, secret header) and
 *      the daemon response is relayed.
 *
 * Mocks the real fetch boundary so the assertion exercises the full
 * route → withDaemon → daemonPost → fetch chain and can pin the forwarded
 * URL + secret header + body.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  DAEMON_SECRET_HEADER,
  getDaemonSecret,
  loadConfig,
  resolveDaemonPort,
} from "@friday/shared";
import type { PresenceReport } from "@friday/shared";

const DAEMON_BASE = `http://127.0.0.1:${resolveDaemonPort(loadConfig())}`;
const { POST } = await import("./+server.js");

function event(opts: { user?: { id: string } | null; body?: unknown }): Parameters<typeof POST>[0] {
  const request = new Request("http://localhost/api/presence", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const user = "user" in opts ? opts.user : { id: "u1" };
  return { request, locals: { user } } as unknown as Parameters<typeof POST>[0];
}

const REPORT: PresenceReport = { deviceId: "device-42", visible: true };

describe("POST /api/presence — session-gated daemon proxy", () => {
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

  it("401s a session-less caller and forwards nothing", async () => {
    const res = await POST(event({ user: null, body: REPORT }));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards the exact PresenceReport + daemon secret to the loopback daemon", async () => {
    const res = await POST(event({ body: REPORT }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAEMON_BASE}/api/presence`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ deviceId: "device-42", visible: true });
    const headers = init.headers as Record<string, string>;
    expect(headers[DAEMON_SECRET_HEADER]).toBe(getDaemonSecret());
  });

  it("forwards visible:false verbatim (the away transition)", async () => {
    await POST(event({ body: { deviceId: "device-7", visible: false } }));
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ deviceId: "device-7", visible: false });
  });
});
