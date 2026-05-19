/**
 * @vitest-environment jsdom
 *
 * Phase 2 unit tests for the Zero sync store boundary. The real
 * `@rocicorp/zero` client opens a live WS connection and only resolves
 * in a browser context — we mock it here to pin our store's contract:
 *
 *   1. Feature flag gating: store stays dormant when the flag is off.
 *   2. JWT refresh path: store fetches `/api/sync/refresh` on init and
 *      passes the returned token via Zero's `auth` callback.
 *   3. Row-to-AgentInfo mapping: ZeroAgentRow snake_case → AgentInfo
 *      camelCase, including ISO timestamp conversion + nullable
 *      session_id collapsing to `undefined`.
 *
 * These tests don't exercise the WS reconnect or schema-mismatch reload
 * paths — those live inside Zero itself and are pinned by Zero's own
 * test suite. The dashboard-side concern is the boundary above.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock $app/environment (SvelteKit) to declare we're in a browser-like
// context for the test. The store guards against SSR by checking
// `browser`.
vi.mock("$app/environment", () => ({ browser: true }));

// Hoisted mocks for @rocicorp/zero. The store imports `Zero`; we
// capture each instance + its `auth` callback so we can assert against
// them post-construction.
type MockedZero = {
  query: {
    agents: {
      where: () => MockedZero["query"]["agents"];
    };
  };
  preload: ReturnType<typeof vi.fn>;
  materialize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  // Capture the constructor args so tests can inspect them.
  __ctorOpts: Record<string, unknown>;
};
const instances: MockedZero[] = [];

vi.mock("@rocicorp/zero", () => {
  class Zero {
    query = {
      agents: {
        where: () => this.query.agents,
      },
    };
    preload = vi.fn(() => ({ cleanup: vi.fn(), complete: Promise.resolve() }));
    materialize = vi.fn(() => ({
      data: [] as unknown[],
      addListener: vi.fn(() => () => {}),
      destroy: vi.fn(),
    }));
    close = vi.fn();
    __ctorOpts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.__ctorOpts = opts;
      instances.push(this as unknown as MockedZero);
    }
  }
  return { Zero };
});

// Schema mock — the store imports `schema` + `Schema`; the values don't
// matter to the test since we mock Zero entirely.
vi.mock("@friday/shared/sync", () => ({
  schema: { tables: [] },
}));

// Install a minimal in-memory localStorage stub: the vitest-bundled
// jsdom build doesn't implement Storage methods reliably.
function installLocalStorageStub(): Map<string, string> {
  const store = new Map<string, string>();
  const fakeStorage: Storage = {
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
  };
  vi.stubGlobal("localStorage", fakeStorage);
  return store;
}

beforeEach(() => {
  instances.length = 0;
  installLocalStorageStub();
  // Stub fetch with the refresh-token response.
  const fetchSpy = vi.fn(async () =>
    new Response(
      JSON.stringify({
        token: "test-token-123",
        deviceId: "test-device-id",
        expiresAt: Date.now() + 900_000,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function importStore(): Promise<typeof import("./zero.svelte.js")> {
  return await import("./zero.svelte.js");
}

describe("useZeroSidebar feature flag", () => {
  it("returns false by default (no flag set)", async () => {
    const { useZeroSidebar } = await importStore();
    expect(useZeroSidebar()).toBe(false);
  });

  it("returns true when localStorage opt-in is set", async () => {
    localStorage.setItem("friday:flag:use-zero-sidebar", "1");
    const { useZeroSidebar } = await importStore();
    expect(useZeroSidebar()).toBe(true);
  });

  it("rejects a non-'1' localStorage value", async () => {
    localStorage.setItem("friday:flag:use-zero-sidebar", "true");
    const { useZeroSidebar } = await importStore();
    // The store's strict check is === "1"; "true" doesn't qualify so
    // the feature stays off — pinning this so a future loosening of
    // the check is deliberate.
    expect(useZeroSidebar()).toBe(false);
  });
});

describe("ZeroSidebarStore initialization", () => {
  it("does NOT construct a Zero client when the flag is off", async () => {
    await importStore();
    // Let any microtasks settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(instances).toHaveLength(0);
  });

  it("fetches /api/sync/refresh and constructs Zero with the device id when flag is on", async () => {
    localStorage.setItem("friday:flag:use-zero-sidebar", "1");
    await importStore();
    // Give the async init time to fetch + construct.
    await new Promise((r) => setTimeout(r, 20));

    // /api/sync/refresh was called.
    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/sync/refresh");
    expect((init as RequestInit).method).toBe("POST");

    // Zero was constructed with the deviceId as userID and an auth
    // callback that re-fetches the token.
    expect(instances).toHaveLength(1);
    const opts = instances[0].__ctorOpts;
    expect(opts.userID).toBe("test-device-id");
    expect(typeof opts.auth).toBe("function");
    expect(opts.kvStore).toBe("mem");
  });

  it("Zero's auth callback re-fetches a fresh token on each invocation", async () => {
    localStorage.setItem("friday:flag:use-zero-sidebar", "1");
    await importStore();
    await new Promise((r) => setTimeout(r, 20));

    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const callsBefore = fetchSpy.mock.calls.length;
    const auth = instances[0].__ctorOpts.auth as () => Promise<string>;
    const token = await auth();
    expect(token).toBe("test-token-123");
    // One additional POST /api/sync/refresh fired.
    expect(fetchSpy.mock.calls.length).toBe(callsBefore + 1);
  });
});

describe("toAgentInfo mapping (via materialize update)", () => {
  it("converts snake_case ZeroAgentRow → camelCase AgentInfo with ISO timestamps", async () => {
    localStorage.setItem("friday:flag:use-zero-sidebar", "1");
    // Capture the listener so we can drive an update with a known payload.
    const listeners: Array<(data: unknown) => void> = [];
    const mockedZero = await import("@rocicorp/zero");
    const ZeroCtor = mockedZero.Zero as unknown as new (
      opts: Record<string, unknown>,
    ) => MockedZero;
    // Patch the materialize mock to register our listener and return
    // a snapshot that mirrors what zero-cache would send.
    const origCtor = ZeroCtor;
    const patched = function (opts: Record<string, unknown>) {
      const inst = new origCtor(opts);
      inst.materialize = vi.fn(() => {
        const view = {
          data: [
            {
              name: "alpha",
              type: "builder",
              status: "working",
              session_id: "sess-1",
              created_at: 1_700_000_000_000,
              updated_at: 1_700_000_001_000,
            },
            {
              name: "beta",
              type: "bare",
              status: "idle",
              session_id: null,
              created_at: 1_700_000_000_000,
              updated_at: 1_700_000_002_000,
            },
          ],
          addListener: vi.fn((listener: (data: unknown) => void) => {
            listeners.push(listener);
            return () => {};
          }),
          destroy: vi.fn(),
        };
        return view;
      });
      return inst;
    };
    (mockedZero as unknown as { Zero: unknown }).Zero = patched;

    const { zeroSidebar } = await importStore();
    await new Promise((r) => setTimeout(r, 30));

    // The seeded snapshot should already be applied to the store.
    expect(zeroSidebar.agents).toHaveLength(2);
    expect(zeroSidebar.agents[0]).toMatchObject({
      name: "alpha",
      type: "builder",
      status: "working",
      session_id: "sess-1",
    });

    // chat.agents (the legacy shape) should mirror the same rows in
    // camelCase, with the null session_id collapsed to undefined.
    const { chat } = await import("./chat.svelte.js");
    expect(chat.agents).toHaveLength(2);
    expect(chat.agents[0]).toMatchObject({
      name: "alpha",
      type: "builder",
      status: "working",
      sessionId: "sess-1",
    });
    expect(chat.agents[1].sessionId).toBeUndefined();
    expect(chat.agents[0].createdAt).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );
    expect(chat.agents[1].updatedAt).toBe(
      new Date(1_700_000_002_000).toISOString(),
    );

    // Restore for other tests.
    (mockedZero as unknown as { Zero: unknown }).Zero = origCtor;
  });
});
