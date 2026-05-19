/**
 * Contract test for /api/sync/refresh — the JWT mint endpoint that
 * bridges BetterAuth → Zero. Verifies:
 *   1. 401 when there's no session in locals.
 *   2. 500 when ZERO_AUTH_SECRET is absent (setup invariant).
 *   3. Happy path: mints a verifiable HS256 JWT with the expected
 *      claims, ensures `friday-device-id` cookie + client_devices row,
 *      both keyed to the SAME deviceId across calls.
 *
 * Drives the endpoint module directly with a stub `RequestEvent` —
 * lighter than spinning up a real HTTP listener and matches the
 * Phase 2 row-state pre/post-condition contract (plan §5).
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";
import { verifyZeroJwt } from "@friday/shared/sync";

let handle: TestDbHandle;
let endpoint: typeof import("./+server.js");
let getClientDevice: typeof import("@friday/shared/services")["getClientDevice"];

beforeAll(async () => {
  handle = await createTestDb({ label: "sync_refresh" });
  // ZERO_AUTH_SECRET would normally be set by ensureFridayEnv() at
  // process start; createTestDb only handles DATABASE_URL.
  process.env.ZERO_AUTH_SECRET ??= "test-zero-secret";
  endpoint = await import("./+server.js");
  ({ getClientDevice } = await import("@friday/shared/services"));
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

interface CookieStore {
  store: Map<string, string>;
  set: (
    name: string,
    value: string,
    opts?: Record<string, unknown>,
  ) => void;
  get: (name: string) => string | undefined;
}

function makeCookies(initial: Record<string, string> = {}): CookieStore {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    set: (name, value) => {
      store.set(name, value);
    },
    get: (name) => store.get(name),
  };
}

interface CallOpts {
  user?: { id: string; email: string; name: string } | null;
  cookies?: Record<string, string>;
  userAgent?: string;
}

async function callPost(opts: CallOpts = {}): Promise<{
  response: Response;
  cookies: CookieStore;
}> {
  const cookies = makeCookies(opts.cookies);
  const event = {
    locals: { user: opts.user ?? null },
    cookies,
    request: new Request("http://localhost/api/sync/refresh", {
      method: "POST",
      headers: opts.userAgent ? { "user-agent": opts.userAgent } : {},
    }),
  };
  // The SvelteKit RequestHandler signature is broad; cast through unknown
  // to silence TS for the stub shape.
  const response = await (endpoint.POST as unknown as (
    e: typeof event,
  ) => Response | Promise<Response>)(event);
  return { response, cookies };
}

describe("POST /api/sync/refresh", () => {
  it("returns 401 when there's no session in locals.user", async () => {
    const { response } = await callPost({ user: null });
    expect(response.status).toBe(401);
  });

  it("returns 500 when ZERO_AUTH_SECRET is missing", async () => {
    const saved = process.env.ZERO_AUTH_SECRET;
    delete process.env.ZERO_AUTH_SECRET;
    try {
      const { response } = await callPost({
        user: { id: "user-1", email: "u@x", name: "u" },
      });
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("zero-auth-secret-missing");
    } finally {
      process.env.ZERO_AUTH_SECRET = saved;
    }
  });

  it("happy path: mints a verifiable JWT, sets cookie, upserts client_devices", async () => {
    const before = Date.now();
    const { response, cookies } = await callPost({
      user: { id: "user-happy", email: "h@x", name: "Happy" },
      userAgent: "Mozilla/Test",
    });
    const after = Date.now();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      token: string;
      deviceId: string;
      expiresAt: number;
    };

    // Cookie was set on the response with the same deviceId.
    expect(cookies.get("friday-device-id")).toBe(body.deviceId);

    // JWT verifies with the same secret and carries the claims we
    // expect; exp is roughly now+15min.
    const claims = verifyZeroJwt(body.token, process.env.ZERO_AUTH_SECRET!);
    expect(claims).not.toBeNull();
    expect(claims!.userId).toBe("user-happy");
    expect(claims!.deviceId).toBe(body.deviceId);
    expect(claims!.exp - claims!.iat).toBe(15 * 60);

    // expiresAt matches the JWT's exp.
    expect(body.expiresAt).toBe(claims!.exp * 1000);

    // client_devices row exists and matches.
    const row = await getClientDevice(body.deviceId);
    expect(row).not.toBeNull();
    expect(row!.userId).toBe("user-happy");
    expect(row!.userAgent).toBe("Mozilla/Test");
    expect(row!.firstSeenAt).toBeGreaterThanOrEqual(before);
    expect(row!.lastSyncAt).toBeLessThanOrEqual(after + 1000);
  });

  it("idempotent: same deviceId across subsequent calls (cookie carries through)", async () => {
    const first = await callPost({
      user: { id: "user-idem", email: "i@x", name: "I" },
    });
    const firstBody = (await first.response.json()) as { deviceId: string };
    const cookieValue = first.cookies.get("friday-device-id")!;

    // Second call carrying the cookie (as the browser would).
    const second = await callPost({
      user: { id: "user-idem", email: "i@x", name: "I" },
      cookies: { "friday-device-id": cookieValue },
    });
    const secondBody = (await second.response.json()) as { deviceId: string };
    expect(secondBody.deviceId).toBe(firstBody.deviceId);
  });

  it("a second user reusing the same deviceId cookie does NOT overwrite the existing row's userId", async () => {
    // The cookie travels with the browser; we don't expect two users to
    // share one profile, but if it happens (shared kiosk), the row's
    // original userId stays put — `upsertClientDevice` pins userId on
    // first insert. The refresh endpoint just mints with the cookie's
    // deviceId; permissions later would gate per-row access. Phase 2
    // pins this invariant.
    const first = await callPost({
      user: { id: "alice", email: "a@x", name: "Alice" },
    });
    const cookieValue = first.cookies.get("friday-device-id")!;

    await callPost({
      user: { id: "bob", email: "b@x", name: "Bob" },
      cookies: { "friday-device-id": cookieValue },
    });

    const row = await getClientDevice(cookieValue);
    expect(row).not.toBeNull();
    expect(row!.userId).toBe("alice"); // original owner sticks
  });
});
