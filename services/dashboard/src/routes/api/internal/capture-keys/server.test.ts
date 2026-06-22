/**
 * FRI-171 (ADR-047) — auth-gate tests for the loopback Capture-key MINTING
 * route `/api/internal/capture-keys`.
 *
 * This route mints `capture:["write"]`-scoped credentials and is protected
 * ONLY by the hand-rolled constant-time daemon-secret comparison in
 * `authorized()`. A credential-minting endpoint whose sole gate is untested
 * hand-rolled crypto-comparison is exactly where "no test == latent bypass"
 * lives (a future edit dropping the `if (!presented) return false` short-
 * circuit, or inverting `diff === 0`). These tests pin the gate's three
 * outcomes for every method:
 *   - NO  `x-friday-daemon-secret` header → 401, and the key service / minting
 *     plugin are NEVER reached.
 *   - WRONG secret → 401, same.
 *   - CORRECT secret → proceeds; POST mints with `permissions:{capture:["write"]}`
 *     for the sole-account userId.
 *
 * The daemon secret + the raw-DB service fns + `auth.api.createApiKey` are
 * mocked so importing the route doesn't reach the real vault/DB/plugin; we
 * assert on the gate outcome and the exact mint args.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

const SECRET = "a".repeat(64);

const getDaemonSecret = vi.fn(() => SECRET);
const listCaptureKeysForUser = vi.fn();
const revokeCaptureKey = vi.fn();
const resolveSoleUserId = vi.fn();
const createApiKey = vi.fn();

vi.mock("@friday/shared", () => ({
  DAEMON_SECRET_HEADER: "x-friday-daemon-secret",
  getDaemonSecret,
}));
vi.mock("@friday/shared/services", () => ({
  listCaptureKeysForUser,
  revokeCaptureKey,
  resolveSoleUserId,
}));
vi.mock("$lib/server/auth", () => ({ auth: { api: { createApiKey } } }));
vi.mock("$lib/server/log", () => ({ logger: { log: vi.fn() } }));

const { GET, POST, DELETE } = await import("./+server.js");

type AnyHandler = typeof GET;

/** Build a RequestEvent with an optional daemon-secret header + JSON body. */
function event(opts: {
  secret?: string;
  body?: unknown;
  search?: string;
}): Parameters<AnyHandler>[0] {
  const headers = new Headers();
  if (opts.secret !== undefined) headers.set("x-friday-daemon-secret", opts.secret);
  const url = `http://127.0.0.1/api/internal/capture-keys${opts.search ?? ""}`;
  const request = new Request(url, {
    method: "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { request, url: new URL(url) } as unknown as Parameters<AnyHandler>[0];
}

describe("/api/internal/capture-keys — daemon-secret gate", () => {
  beforeEach(() => {
    getDaemonSecret.mockReset();
    getDaemonSecret.mockReturnValue(SECRET);
    listCaptureKeysForUser.mockReset();
    revokeCaptureKey.mockReset();
    resolveSoleUserId.mockReset();
    createApiKey.mockReset();
    resolveSoleUserId.mockResolvedValue("user-1");
  });

  // --- no header -------------------------------------------------------------

  it("GET with NO daemon-secret header → 401 and never lists keys", async () => {
    const res = await GET(event({}));
    expect(res.status).toBe(401);
    expect(listCaptureKeysForUser).not.toHaveBeenCalled();
    expect(resolveSoleUserId).not.toHaveBeenCalled();
  });

  it("POST with NO daemon-secret header → 401 and never mints a key", async () => {
    const res = await POST(event({ body: { name: "watch" } }));
    expect(res.status).toBe(401);
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("DELETE with NO daemon-secret header → 401 and never revokes", async () => {
    const res = await DELETE(event({ search: "?id=k1" }));
    expect(res.status).toBe(401);
    expect(revokeCaptureKey).not.toHaveBeenCalled();
  });

  // --- wrong secret ----------------------------------------------------------

  it("POST with a WRONG secret (same length) → 401 and never mints", async () => {
    const res = await POST(event({ secret: "b".repeat(64), body: { name: "watch" } }));
    expect(res.status).toBe(401);
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("POST with a WRONG secret (different length) → 401 and never mints", async () => {
    const res = await POST(event({ secret: "short", body: { name: "watch" } }));
    expect(res.status).toBe(401);
    expect(createApiKey).not.toHaveBeenCalled();
  });

  // --- correct secret --------------------------------------------------------

  it("POST with the CORRECT secret mints a capture:[write] key for the sole account", async () => {
    createApiKey.mockResolvedValue({
      id: "k1",
      key: "fcap_plaintext",
      name: "watch",
      prefix: "fcap_",
      enabled: true,
      createdAt: new Date(0),
      expiresAt: null,
    });
    const res = await POST(event({ secret: SECRET, body: { name: "watch" } }));
    expect(res.status).toBe(201);
    expect(createApiKey).toHaveBeenCalledTimes(1);
    expect(createApiKey).toHaveBeenCalledWith({
      body: {
        userId: "user-1",
        name: "watch",
        prefix: "fcap_",
        permissions: { capture: ["write"] },
      },
    });
    await expect(res.json()).resolves.toMatchObject({ key: "fcap_plaintext" });
  });

  it("GET with the CORRECT secret lists the sole account's keys", async () => {
    listCaptureKeysForUser.mockResolvedValue([]);
    const res = await GET(event({ secret: SECRET }));
    expect(res.status).toBe(200);
    expect(listCaptureKeysForUser).toHaveBeenCalledWith("user-1");
  });
});
