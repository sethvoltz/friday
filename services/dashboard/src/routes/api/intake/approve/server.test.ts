/**
 * FRI-171 (ADR-047) — the Approve proxy must relay the daemon's SPECIFIC
 * domain-rejection reason to the UI (review finding #2), not flatten every
 * non-2xx to a generic 502. The daemon returns a structured 409
 * `{ ok:false, error:"payload no longer valid for core:ticket" }` on a
 * re-validation/executor failure; the user must see THAT, not "approve failed".
 *
 * We mock `daemonPostResult` (the non-throwing variant the proxy now uses) and
 * the session `locals.user`, and assert each outcome maps to the right
 * status + body. The triage/undo proxies share the same shape.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import type { DaemonPostOutcome } from "$lib/server/daemon";

const daemonPostResult = vi.fn();

vi.mock("$lib/server/daemon", () => ({ daemonPostResult }));
vi.mock("$lib/server/log", () => ({ logger: { log: vi.fn() } }));

const { POST } = await import("./+server.js");

function event(opts: { user?: { id: string } | null; body?: unknown }): Parameters<typeof POST>[0] {
  const request = new Request("http://localhost/api/intake/approve", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const user = "user" in opts ? opts.user : { id: "u1" };
  return {
    request,
    locals: { user },
  } as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/intake/approve — proxy relays the daemon's reason", () => {
  beforeEach(() => daemonPostResult.mockReset());

  it("401s a session-less caller and never proxies", async () => {
    const res = await POST(event({ user: null, body: { id: "p1" } }));
    expect(res.status).toBe(401);
    expect(daemonPostResult).not.toHaveBeenCalled();
  });

  it("400s a missing id and never proxies", async () => {
    const res = await POST(event({ body: {} }));
    expect(res.status).toBe(400);
    expect(daemonPostResult).not.toHaveBeenCalled();
  });

  it("relays the daemon's verdict on success", async () => {
    daemonPostResult.mockResolvedValue({
      kind: "ok",
      status: 200,
      body: { ok: true, undoable: true, deepLink: "/schedules?undo=x" },
    } satisfies DaemonPostOutcome<unknown>);
    const res = await POST(event({ body: { id: "p1" } }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, undoable: true });
  });

  it("relays the daemon's SPECIFIC 409 reason (not a generic 502)", async () => {
    daemonPostResult.mockResolvedValue({
      kind: "rejected",
      status: 409,
      body: { ok: false, error: "payload no longer valid for core:ticket" },
    } satisfies DaemonPostOutcome<unknown>);
    const res = await POST(event({ body: { id: "p1" } }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "payload no longer valid for core:ticket",
    });
  });

  it("returns a generic 502 on a transport failure (the daemon never answered)", async () => {
    daemonPostResult.mockResolvedValue({
      kind: "transport",
      error: new Error("ECONNREFUSED"),
    } satisfies DaemonPostOutcome<unknown>);
    const res = await POST(event({ body: { id: "p1" } }));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "approve_failed" });
  });
});
