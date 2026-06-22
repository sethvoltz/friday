/**
 * FRI-171 (ADR-047) — contract tests for the stateless Capture endpoint
 * `POST /api/capture`.
 *
 * Two load-bearing properties are pinned here:
 *
 *  1. Capture keys mint NO session. The endpoint authenticates with the
 *     better-auth apiKey plugin's `verifyApiKey` (a session-less check) and
 *     NEVER calls `getSession`. Combined with `enableSessionForAPIKeys: false`
 *     in auth.ts (asserted in `auth.capture-key-no-session.test.ts`), a request
 *     bearing `x-api-key` cannot become a logged-in session. We assert the
 *     route never touches `getSession` and that an invalid key is rejected with
 *     a hard 401 (NOT a 302 → /login).
 *
 *  2. Cross-boundary proxy (AC9): on a VALID key the Capture is forwarded over
 *     loopback to the daemon `POST /api/intake` exactly once with the
 *     `{ source, text }` body, and the daemon's `{ cleaned, disposition,
 *     rationale }` verdict is returned verbatim. `daemonPost` carries the
 *     `x-friday-daemon-secret` (verified at the daemon helper layer); here we
 *     mock `daemonPost` and assert the call args + the relayed response.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import type { DaemonPostOutcome } from "$lib/server/daemon";

const verifyApiKey = vi.fn();
const getSession = vi.fn();
const daemonPostResult = vi.fn();

vi.mock("$lib/server/auth", () => ({
  auth: { api: { verifyApiKey, getSession } },
}));
vi.mock("$lib/server/daemon", () => ({ daemonPostResult }));
vi.mock("$lib/server/log", () => ({ logger: { log: vi.fn() } }));

/** Sugar for building the non-throwing daemon outcomes. */
const ok = <T>(body: T): DaemonPostOutcome<T> => ({ kind: "ok", status: 200, body });
const timeout = (): DaemonPostOutcome<never> => ({ kind: "timeout" });
const transport = (): DaemonPostOutcome<never> => ({
  kind: "transport",
  error: new Error("ECONNREFUSED"),
});

const { POST } = await import("./+server.js");

/** Build a minimal SvelteKit RequestEvent carrying a JSON capture body. */
function event(opts: { key?: string; body?: unknown }): Parameters<typeof POST>[0] {
  const headers = new Headers();
  if (opts.key !== undefined) headers.set("x-api-key", opts.key);
  const request = new Request("http://localhost/api/capture", {
    method: "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { request } as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/capture — capture-key auth + daemon proxy", () => {
  beforeEach(() => {
    verifyApiKey.mockReset();
    getSession.mockReset();
    daemonPostResult.mockReset();
  });

  it("rejects a missing key with 401 (never a 302 redirect) and never proxies", async () => {
    const res = await POST(event({ body: { text: "buy milk", source: "watch" } }));
    expect(res.status).toBe(401);
    expect(verifyApiKey).not.toHaveBeenCalled();
    expect(daemonPostResult).not.toHaveBeenCalled();
  });

  it("rejects an invalid key with 401 and does not proxy to the daemon", async () => {
    verifyApiKey.mockResolvedValue({ valid: false });
    const res = await POST(event({ key: "bad-key", body: { text: "buy milk" } }));
    expect(res.status).toBe(401);
    expect(verifyApiKey).toHaveBeenCalledOnce();
    expect(daemonPostResult).not.toHaveBeenCalled();
  });

  it("verifies the key for the capture:write scope and never mints a session", async () => {
    verifyApiKey.mockResolvedValue({ valid: true });
    daemonPostResult.mockResolvedValue(
      ok({ cleaned: "Buy milk", disposition: "act", rationale: "reminder", kind: "done" }),
    );
    await POST(event({ key: "good-key", body: { text: "buy milk", source: "watch" } }));
    expect(verifyApiKey).toHaveBeenCalledWith({
      body: { key: "good-key", permissions: { capture: ["write"] } },
    });
    // A Capture key authenticates a stateless POST — it must NOT log anyone in.
    expect(getSession).not.toHaveBeenCalled();
  });

  it("on a valid key proxies the capture to the daemon once and relays the verdict (AC9)", async () => {
    verifyApiKey.mockResolvedValue({ valid: true });
    daemonPostResult.mockResolvedValue(
      ok({
        cleaned: "Buy milk tomorrow",
        disposition: "act",
        rationale: "scheduled a reminder",
        kind: "done",
      }),
    );

    const res = await POST(
      event({ key: "good-key", body: { text: "  buy milk tomorrow  ", source: "watch" } }),
    );

    expect(res.status).toBe(200);
    expect(daemonPostResult).toHaveBeenCalledOnce();
    expect(daemonPostResult).toHaveBeenCalledWith("/api/intake", {
      source: "watch",
      text: "buy milk tomorrow",
    });
    await expect(res.json()).resolves.toEqual({
      cleaned: "Buy milk tomorrow",
      disposition: "act",
      rationale: "scheduled a reminder",
    });
  });

  it("coerces an unknown source to quick_add before forwarding", async () => {
    verifyApiKey.mockResolvedValue({ valid: true });
    daemonPostResult.mockResolvedValue(
      ok({ cleaned: "x", disposition: "propose", rationale: "r", kind: "proposed" }),
    );
    await POST(event({ key: "good-key", body: { text: "note", source: "telegram" } }));
    expect(daemonPostResult).toHaveBeenCalledWith("/api/intake", {
      source: "quick_add",
      text: "note",
    });
  });

  it("rejects an empty capture body with 400 before proxying", async () => {
    verifyApiKey.mockResolvedValue({ valid: true });
    const res = await POST(event({ key: "good-key", body: { text: "   " } }));
    expect(res.status).toBe(400);
    expect(daemonPostResult).not.toHaveBeenCalled();
  });

  it("returns a 202 queued shape when the daemon is up-but-slow (timeout)", async () => {
    // A timeout means the daemon RECEIVED the Capture; its own intake path
    // guarantees the item lands in the bell, so 202 queued is honest.
    verifyApiKey.mockResolvedValue({ valid: true });
    daemonPostResult.mockResolvedValue(timeout());
    const res = await POST(event({ key: "good-key", body: { text: "remember this" } }));
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      cleaned: "remember this",
      disposition: "propose",
    });
  });

  it("returns 503 (retry) — NOT 202 queued — when the daemon is DOWN (transport failure)", async () => {
    // A transport failure means the daemon NEVER received the Capture; no Inbox
    // row exists. Telling the caller "queued" would silently drop it.
    verifyApiKey.mockResolvedValue({ valid: true });
    daemonPostResult.mockResolvedValue(transport());
    const res = await POST(event({ key: "good-key", body: { text: "remember this" } }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "capture not accepted, retry" });
  });
});
