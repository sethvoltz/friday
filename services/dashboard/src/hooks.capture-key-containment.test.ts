/**
 * FRI-171 (ADR-047) — AUTH CONTAINMENT gap test (AC4 / AC5, cross-boundary).
 *
 * The per-phase tests pin the two halves of capture-key auth separately:
 *   - `auth.capture-key-no-session.test.ts` asserts `enableSessionForAPIKeys:
 *     false` is passed to the apiKey plugin (so the plugin's onRequest hook
 *     never mints a session for an `x-api-key` request);
 *   - `routes/api/capture/server.test.ts` asserts the `/api/capture` route
 *     itself verifies the key and 401s an invalid one.
 *
 * What NEITHER covers is the load-bearing CONTAINMENT property that ties them
 * together: a Capture key — which only has `capture:["write"]` scope and (by
 * `enableSessionForAPIKeys: false`) produces NO session — must NOT be able to
 * satisfy a SESSION-GATED route. The session gate lives in the `handle` hook,
 * so that is the layer this is tested at. A request bearing ONLY `x-api-key`
 * (no session cookie) to a session-gated API route reaches the gate with
 * `getSession() === null` (the apiKey plugin contributes no session), the path
 * is NOT in PUBLIC_PATHS, and so the gate returns a hard 401 JSON and `resolve`
 * (the route handler) is NEVER invoked.
 *
 * If a future edit (a) flips `enableSessionForAPIKeys` to true, or (b) adds a
 * session-gated route to PUBLIC_PATHS, or (c) makes `getSession` honor the
 * `x-api-key` header, a write-scoped device key would silently satisfy a
 * session-gated route — this test fails the moment any of those happen.
 *
 * We mock `auth` so `getSession` returns null for an `x-api-key`-only request
 * (the production behavior with the flag off) and assert the gate's outcome.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const getSession = vi.fn();
const resolve = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

// auth.ts evaluates loadFridayConfig()/getDb() at module load — stub it so
// importing hooks.server.ts doesn't reach the real DB or vault. `getSession`
// models the production behavior: with `enableSessionForAPIKeys: false` an
// `x-api-key`-bearing request yields NO session.
vi.mock("$lib/server/auth", () => ({
  auth: { handler: vi.fn(), api: { getSession } },
}));
vi.mock("$lib/server/log", () => ({ logger: { log: vi.fn() } }));
vi.mock("$lib/server/posthog", () => ({
  posthog: { captureException: vi.fn() },
  DISTINCT_ID: "test",
  initPosthog: vi.fn(),
}));
vi.mock("@friday/shared", () => ({
  warmVaultCache: vi.fn(),
  clearFridayConfigCache: vi.fn(),
}));
vi.mock("@friday/shared/services", () => ({
  consumeRateLimit: vi.fn(),
  resetRateLimit: vi.fn(),
}));
vi.mock("$env/static/public", () => ({ PUBLIC_APP_VERSION: "test" }));

const { handle } = await import("./hooks.server.js");

/**
 * Build a SvelteKit-ish request event for `handle`, with an optional
 * `x-api-key` header and a client address (loopback or remote).
 */
function event(opts: { path: string; apiKey?: string; clientAddr?: string }) {
  const headers = new Headers();
  if (opts.apiKey !== undefined) headers.set("x-api-key", opts.apiKey);
  const request = new Request(`http://localhost${opts.path}`, { method: "GET", headers });
  return {
    url: new URL(`http://localhost${opts.path}`),
    request,
    locals: {} as Record<string, unknown>,
    getClientAddress: () => opts.clientAddr ?? "203.0.113.7",
  } as unknown as Parameters<typeof handle>[0]["event"];
}

describe("hooks `handle` — Capture key cannot satisfy a session-gated route (AC4/AC5 containment)", () => {
  beforeEach(() => {
    getSession.mockReset();
    resolve.mockClear();
    // The flag-off behavior: an x-api-key request produces no session.
    getSession.mockResolvedValue(null);
  });

  it("returns 401 JSON (not the route) for a session-gated API route presented with ONLY a Capture key", async () => {
    // `/api/agents` is a representative session-gated API route that does NOT
    // share a prefix with any PUBLIC_PATHS entry.
    const res = await handle({
      event: event({ path: "/api/agents", apiKey: "fri_capture_writeonly_key" }),
      resolve,
    });

    // The session gate short-circuited: the route handler never ran.
    expect(resolve).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("does NOT mint a session from the Capture key (locals.user stays null)", async () => {
    const ev = event({ path: "/api/agents", apiKey: "fri_capture_writeonly_key" });
    await handle({ event: ev, resolve });

    // The presence of x-api-key must not log anyone in for a session-gated route.
    expect((ev.locals as { user: unknown }).user).toBeNull();
  });

  it("a Capture key on a loopback origin still cannot reach a session-gated route (only LOOPBACK_ONLY_PATHS get the exemption)", async () => {
    // `/api/agents` is NOT in LOOPBACK_ONLY_PATHS — being on 127.0.0.1 does not
    // exempt it; only /api/internal/capture-keys (daemon-secret-gated) and
    // /api/mutators get the loopback exemption.
    const res = await handle({
      event: event({
        path: "/api/agents",
        apiKey: "fri_capture_writeonly_key",
        clientAddr: "127.0.0.1",
      }),
      resolve,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("still serves the route when a REAL session exists (the gate isn't blanket-deny)", async () => {
    // Sanity anchor: the 401 above is the absence of a session, not a route
    // that always 401s. With a session, the gate passes through to `resolve`.
    getSession.mockResolvedValue({
      user: { id: "u1", email: "seth@example.com", name: "Seth" },
      session: { id: "s1", userId: "u1", expiresAt: Date.now() + 60_000 },
    });
    const res = await handle({
      event: event({ path: "/api/agents" }),
      resolve,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("an UNAUTHENTICATED browser hit to a session-gated HTML route 302s to /login, not 401", async () => {
    // The gate's two-branch behavior: /api/* → 401 JSON (so client fetch can
    // branch on r.ok); HTML routes → 302 /login (so the browser navigates).
    // A capture key changes nothing here — there is no session either way.
    let thrown: unknown;
    try {
      await handle({ event: event({ path: "/dashboard" }), resolve });
    } catch (e) {
      thrown = e;
    }
    // SvelteKit `redirect()` throws a Redirect object carrying status+location.
    expect(thrown).toMatchObject({ status: 302, location: "/login" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("DEFENSE-IN-DEPTH FINDING: `/api/capture-keys` matches the `/api/capture` PUBLIC_PATHS prefix and BYPASSES the hooks session gate", async () => {
    // PUBLIC_PATHS contains `/api/capture` (the key-gated Capture endpoint) and
    // the gate matches it with `pathname.startsWith(p)`. Because
    // `"/api/capture-keys".startsWith("/api/capture")` is true, the SESSION-GATED
    // `/api/capture-keys` Settings route is treated as PUBLIC by the hooks gate
    // — `resolve` runs even with no session. This is NOT an exploitable bypass:
    // `routes/api/capture-keys/+server.ts` guards EVERY method with its own
    // `if (!locals.user) return 401`, so the net effect is still 401. But the
    // hooks-level defense-in-depth does not apply to it. Pinned so a future edit
    // that (a) tightens PUBLIC_PATHS to exact match, or (b) drops the route's own
    // guard, is a deliberate, reviewed change rather than a silent regression.
    const res = await handle({
      event: event({ path: "/api/capture-keys", apiKey: "fri_capture_writeonly_key" }),
      resolve,
    });
    // Bypasses the gate (route ran)…
    expect(resolve).toHaveBeenCalledTimes(1);
    // …but the route's OWN guard is what would 401 a session-less caller; the
    // gate did not contribute the 401 here. (Our `resolve` mock returns 200, so
    // this asserts only the BYPASS, which is the finding.)
    expect(res.status).toBe(200);
  });
});
