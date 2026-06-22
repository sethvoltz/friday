/**
 * FRI-171 (ADR-047) — session-gate tests for the Settings-card Capture-key
 * route `/api/capture-keys`.
 *
 * `/api/capture-keys` matches the `/api/capture` PUBLIC_PATHS prefix, so the
 * hooks-level session gate BYPASSES it (pinned in
 * `hooks.capture-key-containment.test.ts`). That makes THIS route's own
 * `if (!locals.user) return 401` the SOLE guard for the prefix-matched-public
 * route. The containment test explicitly leans on that guard; here we pin it
 * directly: every method 401s a session-less caller and NEVER reaches the
 * BetterAuth apiKey plugin.
 *
 * `auth` is mocked so importing the route doesn't reach the real plugin/DB; we
 * assert on the guard outcome + that the plugin call is not made.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

const listApiKeys = vi.fn();
const createApiKey = vi.fn();
const deleteApiKey = vi.fn();

vi.mock("$lib/server/auth", () => ({
  auth: { api: { listApiKeys, createApiKey, deleteApiKey } },
}));
vi.mock("$lib/server/log", () => ({ logger: { log: vi.fn() } }));

const { GET, POST, DELETE } = await import("./+server.js");

type AnyHandler = typeof GET;

/** Build a RequestEvent with optional `locals.user` and query string. */
function event(opts: {
  user?: { id: string } | null;
  body?: unknown;
  search?: string;
}): Parameters<AnyHandler>[0] {
  const url = `http://localhost/api/capture-keys${opts.search ?? ""}`;
  const request = new Request(url, {
    method: "POST",
    headers: new Headers(),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return {
    request,
    url: new URL(url),
    locals: { user: opts.user ?? null },
  } as unknown as Parameters<AnyHandler>[0];
}

describe("/api/capture-keys — session gate (sole guard for the prefix-matched-public route)", () => {
  beforeEach(() => {
    listApiKeys.mockReset();
    createApiKey.mockReset();
    deleteApiKey.mockReset();
  });

  it("GET with no session → 401 and never lists keys", async () => {
    const res = await GET(event({ user: null }));
    expect(res.status).toBe(401);
    expect(listApiKeys).not.toHaveBeenCalled();
  });

  it("POST with no session → 401 and never mints a key", async () => {
    const res = await POST(event({ user: null, body: { name: "x" } }));
    expect(res.status).toBe(401);
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("DELETE with no session → 401 and never revokes a key", async () => {
    const res = await DELETE(event({ user: null, search: "?id=k1" }));
    expect(res.status).toBe(401);
    expect(deleteApiKey).not.toHaveBeenCalled();
  });

  it("POST with a session mints a capture:[write] key for the session user", async () => {
    createApiKey.mockResolvedValue({
      id: "k1",
      key: "fcap_plaintext",
      name: "x",
      createdAt: new Date(0),
    });
    const res = await POST(event({ user: { id: "u1" }, body: { name: "x" } }));
    expect(res.status).toBe(201);
    expect(createApiKey).toHaveBeenCalledWith({
      body: { userId: "u1", name: "x", prefix: "fcap_", permissions: { capture: ["write"] } },
    });
    await expect(res.json()).resolves.toMatchObject({ key: "fcap_plaintext" });
  });
});
