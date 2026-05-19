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
  query: Record<string, unknown>;
  preload: ReturnType<typeof vi.fn>;
  materialize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  mutate: Record<string, ReturnType<typeof vi.fn>>;
  // Capture the constructor args so tests can inspect them.
  __ctorOpts: Record<string, unknown>;
};
const instances: MockedZero[] = [];

vi.mock("@rocicorp/zero", () => {
  // Chainable query builder. Every method returns the same proxy so a
  // chain like `.where(...).where(...).orderBy(...).limit(...)` resolves
  // without errors and so tests can inspect the recorded call sequence
  // via __calls.
  function makeQueryProxy(): Record<string, unknown> {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const proxy: Record<string, unknown> = { __calls: calls };
    const methods = ["where", "orderBy", "limit", "start", "related", "one"];
    for (const m of methods) {
      proxy[m] = (...args: unknown[]) => {
        calls.push({ method: m, args });
        return proxy;
      };
    }
    return proxy;
  }
  class Zero {
    query: Record<string, unknown>;
    preload = vi.fn(() => ({ cleanup: vi.fn(), complete: Promise.resolve() }));
    materialize = vi.fn(() => ({
      data: [] as unknown[],
      addListener: vi.fn(() => () => {}),
      destroy: vi.fn(),
    }));
    close = vi.fn();
    // Phase 4.1: custom mutators surface. The store calls
    // `this.#zero.mutate.<name>(args)`. The test mock returns a
    // chained mutator-shape object whose call returns a no-op
    // MutatorResult shape so the code path doesn't throw. Specific
    // tests that exercise mutator invocation override this on the
    // instance.
    mutate = {
      markRead: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      reportClientStats: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      forgetDevice: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
    };
    __ctorOpts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.__ctorOpts = opts;
      // Phase 3+ tables: each table is its own chain-able query proxy.
      this.query = {
        agents: makeQueryProxy(),
        tickets: makeQueryProxy(),
        schedules: makeQueryProxy(),
        memory_entries: makeQueryProxy(),
        apps: makeQueryProxy(),
        mail: makeQueryProxy(),
        client_devices: makeQueryProxy(),
        blocks: makeQueryProxy(),
      };
      instances.push(this as unknown as MockedZero);
    }
  }
  // `createBuilder(schema)` returns the standalone schema-query builder
  // used by our store post-1.5. The shape mirrors the live Zero client's
  // `z.query` field, just decoupled from a connection.
  const createBuilder = () => ({
    agents: makeQueryProxy(),
    tickets: makeQueryProxy(),
    blocks: makeQueryProxy(),
  });
  return { Zero, createBuilder };
});

// Schema mock — the store imports `schema` + `Schema`; the values don't
// matter to the test since we mock Zero entirely. `createMutators` is
// added in Phase 4.1 — the mock returns an empty mutator map since the
// tests don't drive mutator calls.
vi.mock("@friday/shared/sync", () => ({
  schema: { tables: [] },
  createMutators: () => ({}),
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
        userId: "test-user-id",
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

describe("useZero feature flag", () => {
  it("returns false by default (no flag set)", async () => {
    const { useZero } = await importStore();
    expect(useZero()).toBe(false);
  });

  it("returns true when the universal localStorage opt-in is set", async () => {
    localStorage.setItem("friday:flag:use-zero", "1");
    const { useZero } = await importStore();
    expect(useZero()).toBe(true);
  });

  it("returns true via the legacy `friday:flag:use-zero-sidebar` alias", async () => {
    // Phase 2 shipped under the per-slice key; Phase 3 collapses the
    // flags but keeps the old key working so existing browser
    // profiles continue to opt in without manual migration.
    localStorage.setItem("friday:flag:use-zero-sidebar", "1");
    const { useZero, useZeroSidebar } = await importStore();
    expect(useZero()).toBe(true);
    // Alias still exported for backward compat.
    expect(useZeroSidebar()).toBe(true);
  });

  it("rejects a non-'1' localStorage value", async () => {
    localStorage.setItem("friday:flag:use-zero", "true");
    const { useZero } = await importStore();
    // The store's strict check is === "1"; "true" doesn't qualify so
    // the feature stays off — pinning this so a future loosening of
    // the check is deliberate.
    expect(useZero()).toBe(false);
  });
});

describe("ZeroSyncStore initialization", () => {
  it("does NOT construct a Zero client when the flag is off", async () => {
    await importStore();
    // Let any microtasks settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(instances).toHaveLength(0);
  });

  it("fetches /api/sync/refresh and constructs Zero with the device id when flag is on", async () => {
    localStorage.setItem("friday:flag:use-zero", "1");
    await importStore();
    // Give the async init time to fetch + construct.
    await new Promise((r) => setTimeout(r, 20));

    // /api/sync/refresh was called.
    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/sync/refresh");
    expect((init as RequestInit).method).toBe("POST");

    // Zero was constructed with the BetterAuth user id as userID
    // (Zero's JWT validator requires `sub === userID`) and the JWT
    // string as `auth`.
    expect(instances).toHaveLength(1);
    const opts = instances[0].__ctorOpts;
    expect(opts.userID).toBe("test-user-id");
    expect(opts.auth).toBe("test-token-123");
    expect(opts.kvStore).toBe("mem");
  });
});

describe("toAgentInfo mapping (via materialize update)", () => {
  it("converts snake_case ZeroAgentRow → camelCase AgentInfo with ISO timestamps", async () => {
    localStorage.setItem("friday:flag:use-zero", "1");
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
      // The store calls `materialize` once per slice (agents + tickets
      // in Phase 3.1). Return the populated agent snapshot for the
      // first call and an empty snapshot for everything after.
      let nth = 0;
      inst.materialize = vi.fn(() => {
        const isFirst = nth === 0;
        nth += 1;
        const view = {
          data: isFirst
            ? [
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
              ]
            : [],
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

    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));

    // The seeded snapshot should already be applied to the store.
    expect(zeroSync.agents).toHaveLength(2);
    expect(zeroSync.agents[0]).toMatchObject({
      name: "alpha",
      type: "builder",
      status: "working",
      session_id: "sess-1",
    });
    // Tickets slice (Phase 3.1) seeded with empty snapshot in this
    // mock — confirms the second materialize call is wired but doesn't
    // leak agent rows into `tickets`.
    expect(zeroSync.tickets).toHaveLength(0);

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

describe("Phase 3.7: bindBlocksFor / unbindBlocks", () => {
  it("bindBlocksFor materializes a per-agent query with status filter + ordering + limit", async () => {
    localStorage.setItem("friday:flag:use-zero", "1");
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    expect(instances).toHaveLength(1);
    const z = instances[0];

    zeroSync.bindBlocksFor("friday");
    expect(zeroSync.blocksAgent).toBe("friday");

    // Inspect the recorded call sequence on the blocks-query proxy to
    // verify the filter shape. `streaming` rows MUST be excluded —
    // otherwise the chat would render in-flight placeholders.
    const blocksQuery = z.query.blocks as {
      __calls: Array<{ method: string; args: unknown[] }>;
    };
    expect(blocksQuery.__calls).toEqual([
      { method: "where", args: ["agent_name", "=", "friday"] },
      { method: "where", args: ["status", "!=", "streaming"] },
      { method: "orderBy", args: ["id", "desc"] },
      { method: "limit", args: [50] },
    ]);
    // Materialize was called once for blocks (in addition to the
    // global slice bindings during init).
    const materializeCallCount = z.materialize.mock.calls.length;
    expect(materializeCallCount).toBeGreaterThan(0);
  });

  it("rebinding to a new agent tears down the previous view", async () => {
    localStorage.setItem("friday:flag:use-zero", "1");
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));

    // Track destroy calls on the materialized views.
    const destroyCalls: string[] = [];
    const z = instances[0];
    let blocksMaterializeNth = 0;
    z.materialize = vi.fn(() => {
      const n = blocksMaterializeNth++;
      return {
        data: [],
        addListener: vi.fn(() => () => {}),
        destroy: vi.fn(() => destroyCalls.push(`destroy-${n}`)),
      };
    });

    zeroSync.bindBlocksFor("alpha");
    zeroSync.bindBlocksFor("beta");
    expect(zeroSync.blocksAgent).toBe("beta");
    // First view (alpha) must be torn down on rebind.
    expect(destroyCalls).toContain("destroy-0");
  });

  it("rebinding to the same agent is a no-op", async () => {
    localStorage.setItem("friday:flag:use-zero", "1");
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));

    const z = instances[0];
    let count = 0;
    z.materialize = vi.fn(() => {
      count++;
      return {
        data: [],
        addListener: vi.fn(() => () => {}),
        destroy: vi.fn(),
      };
    });
    zeroSync.bindBlocksFor("friday");
    const after = count;
    zeroSync.bindBlocksFor("friday");
    expect(count).toBe(after);
  });

  it("unbindBlocks clears state + tears down the view", async () => {
    localStorage.setItem("friday:flag:use-zero", "1");
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));

    const z = instances[0];
    let destroyed = false;
    z.materialize = vi.fn(() => ({
      data: [
        {
          id: 1,
          block_id: "b1",
          turn_id: "t1",
          agent_name: "friday",
          session_id: "s1",
          message_id: null,
          block_index: 0,
          role: "user",
          kind: "text",
          source: "user_chat",
          content_json: { text: "x" },
          status: "complete",
          streaming: false,
          origin_mutation_id: null,
          ts: 1_000,
          last_event_seq: 1,
        },
      ],
      addListener: vi.fn(() => () => {}),
      destroy: vi.fn(() => {
        destroyed = true;
      }),
    }));

    zeroSync.bindBlocksFor("friday");
    expect(zeroSync.blocks.length).toBe(1);
    expect(zeroSync.blocksAgent).toBe("friday");

    zeroSync.unbindBlocks();
    expect(zeroSync.blocksAgent).toBeNull();
    expect(zeroSync.blocks).toEqual([]);
    expect(destroyed).toBe(true);
  });

  it("bindBlocksFor called before #init defers and applies once init resolves", async () => {
    // Reproduces the cold-load race: ChatShell mounts and the binder
    // fires the moment SvelteKit hands over, but `#init`'s
    // `/api/sync/refresh` round-trip hasn't resolved yet. Without the
    // pending-agent recovery, the binding is silently dropped.
    localStorage.setItem("friday:flag:use-zero", "1");

    // Stall the refresh fetch so init can't resolve before we call
    // bindBlocksFor — that's the race we're modeling.
    let releaseFetch: () => void = () => {};
    const fetchPromise = new Promise<Response>((resolve) => {
      releaseFetch = () =>
        resolve(
          new Response(
            JSON.stringify({
              token: "test-token-123",
              deviceId: "test-device-id",
              userId: "test-user-id",
              expiresAt: Date.now() + 900_000,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchPromise),
    );

    const { zeroSync } = await importStore();
    // Before init: blocksAgent stays null but the call is queued.
    zeroSync.bindBlocksFor("friday");
    expect(zeroSync.blocksAgent).toBeNull();

    // Release init; the deferred binding should apply.
    releaseFetch();
    await new Promise((r) => setTimeout(r, 40));
    expect(zeroSync.blocksAgent).toBe("friday");
  });

  it("unbindBlocks before init clears the pending agent", async () => {
    localStorage.setItem("friday:flag:use-zero", "1");
    let releaseFetch: () => void = () => {};
    const fetchPromise = new Promise<Response>((resolve) => {
      releaseFetch = () =>
        resolve(
          new Response(
            JSON.stringify({
              token: "x",
              deviceId: "d",
              userId: "u",
              expiresAt: Date.now() + 900_000,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchPromise),
    );

    const { zeroSync } = await importStore();
    zeroSync.bindBlocksFor("alpha"); // queued
    zeroSync.unbindBlocks(); // cancels queue
    releaseFetch();
    await new Promise((r) => setTimeout(r, 40));
    expect(zeroSync.blocksAgent).toBeNull();
  });

  it("onBlocksUpdate fires synchronously with current snapshot on registration", async () => {
    localStorage.setItem("friday:flag:use-zero", "1");
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));

    const seen: unknown[][] = [];
    const unsub = zeroSync.onBlocksUpdate((rows) => {
      seen.push(rows.slice());
    });
    // Sync notification on registration with empty array (no binding yet).
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([]);
    unsub();
  });
});

describe("tickets binding (Phase 3.1)", () => {
  it("seeds zeroSync.tickets from the second materialize call's snapshot", async () => {
    localStorage.setItem("friday:flag:use-zero", "1");
    const mockedZero = await import("@rocicorp/zero");
    const origCtor = mockedZero.Zero as unknown as new (
      opts: Record<string, unknown>,
    ) => MockedZero;
    const patched = function (opts: Record<string, unknown>) {
      const inst = new origCtor(opts);
      let nth = 0;
      inst.materialize = vi.fn(() => {
        const isAgents = nth === 0;
        nth += 1;
        return {
          data: isAgents
            ? []
            : [
                {
                  id: "FRI-1",
                  title: "first ticket",
                  body: null,
                  status: "open",
                  kind: "task",
                  assignee: null,
                  meta_json: null,
                  created_at: 1_700_000_000_000,
                  updated_at: 1_700_000_001_000,
                },
                {
                  id: "FRI-2",
                  title: "second ticket",
                  body: "with body",
                  status: "in_progress",
                  kind: "bug",
                  assignee: "alice",
                  meta_json: { foo: "bar" },
                  created_at: 1_700_000_000_000,
                  updated_at: 1_700_000_005_000,
                },
              ],
          addListener: vi.fn(() => () => {}),
          destroy: vi.fn(),
        };
      });
      return inst;
    };
    (mockedZero as unknown as { Zero: unknown }).Zero = patched;

    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));

    expect(zeroSync.agents).toHaveLength(0);
    expect(zeroSync.tickets).toHaveLength(2);
    expect(zeroSync.tickets[0]).toMatchObject({
      id: "FRI-1",
      title: "first ticket",
      status: "open",
      kind: "task",
    });
    expect(zeroSync.tickets[1]).toMatchObject({
      id: "FRI-2",
      assignee: "alice",
      status: "in_progress",
    });

    (mockedZero as unknown as { Zero: unknown }).Zero = origCtor;
  });
});

describe("Phase 4.1: markRead mutator dispatch", () => {
  it("markRead forwards (deviceId, agentName, blockId) to zero.mutate.markRead", async () => {
    localStorage.setItem("friday:flag:use-zero", "1");
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    expect(instances).toHaveLength(1);
    const z = instances[0];

    zeroSync.markRead("alpha", "blk-42");
    expect(z.mutate.markRead).toHaveBeenCalledTimes(1);
    const args = z.mutate.markRead.mock.calls[0][0] as {
      deviceId: string;
      agentName: string;
      lastSeenBlockId: string;
      ts: number;
    };
    expect(args.deviceId).toBe("test-device-id");
    expect(args.agentName).toBe("alpha");
    expect(args.lastSeenBlockId).toBe("blk-42");
    expect(typeof args.ts).toBe("number");
  });

  it("markRead is silently dropped if Zero hasn't initialized", async () => {
    // No flag → no init → no mutator framework. The call MUST NOT
    // throw — chat shells call markRead unconditionally on focus.
    const { zeroSync } = await importStore();
    expect(() => zeroSync.markRead("alpha", "blk-1")).not.toThrow();
    expect(instances).toHaveLength(0);
  });

  it("the Zero constructor receives `mutators` from createMutators", async () => {
    localStorage.setItem("friday:flag:use-zero", "1");
    await importStore();
    await new Promise((r) => setTimeout(r, 30));
    expect(instances).toHaveLength(1);
    const opts = instances[0].__ctorOpts;
    expect(opts.mutators).toBeDefined();
    // Confirm the createMutators() shape made it in (the test mock
    // returns an empty object; this asserts the property exists).
    expect(typeof opts.mutators).toBe("object");
  });
});

describe("Phase 4.2: reportClientStats + forgetDevice", () => {
  it("fires reportClientStats on connect with the navigator.storage.estimate() reading", async () => {
    localStorage.setItem("friday:flag:use-zero", "1");
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      storage: {
        estimate: vi.fn(async () => ({
          usage: 12_345,
          quota: 1_000_000,
        })),
      } as unknown as StorageManager,
    });
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 40));
    void zeroSync; // suppress unused
    expect(instances).toHaveLength(1);
    const z = instances[0];
    expect(z.mutate.reportClientStats).toHaveBeenCalledTimes(1);
    const args = z.mutate.reportClientStats.mock.calls[0][0] as {
      deviceId: string;
      storageUsedBytes: number;
      storageQuotaBytes: number;
      ts: number;
    };
    expect(args.deviceId).toBe("test-device-id");
    expect(args.storageUsedBytes).toBe(12_345);
    expect(args.storageQuotaBytes).toBe(1_000_000);
    expect(typeof args.ts).toBe("number");
  });

  it("fires reportClientStats even when navigator.storage.estimate is unavailable", async () => {
    // Older Safari etc. — the mutator should still fire so
    // last_seen_at advances; storage fields stay undefined.
    localStorage.setItem("friday:flag:use-zero", "1");
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      // No `storage` field at all.
    });
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 40));
    void zeroSync;
    expect(instances).toHaveLength(1);
    const z = instances[0];
    expect(z.mutate.reportClientStats).toHaveBeenCalled();
    const args = z.mutate.reportClientStats.mock.calls[0][0] as {
      storageUsedBytes?: number;
      storageQuotaBytes?: number;
    };
    expect(args.storageUsedBytes).toBeUndefined();
    expect(args.storageQuotaBytes).toBeUndefined();
  });

  it("handles storage.estimate throwing (SecurityError in cross-origin iframes) without crashing", async () => {
    localStorage.setItem("friday:flag:use-zero", "1");
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      storage: {
        estimate: vi.fn(async () => {
          throw new DOMException("SecurityError", "SecurityError");
        }),
      } as unknown as StorageManager,
    });
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 40));
    void zeroSync;
    expect(instances).toHaveLength(1);
    const z = instances[0];
    // The mutator STILL fires with undefined storage — the throw is
    // swallowed, the row's last_seen_at still advances.
    expect(z.mutate.reportClientStats).toHaveBeenCalled();
  });

  it("forgetDevice forwards the deviceId to zero.mutate.forgetDevice", async () => {
    localStorage.setItem("friday:flag:use-zero", "1");
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 40));
    expect(instances).toHaveLength(1);
    const z = instances[0];
    zeroSync.forgetDevice("dev-to-evict");
    expect(z.mutate.forgetDevice).toHaveBeenCalledTimes(1);
    const args = z.mutate.forgetDevice.mock.calls[0][0] as {
      deviceId: string;
    };
    expect(args.deviceId).toBe("dev-to-evict");
  });

  it("forgetDevice is silent when Zero hasn't initialized", async () => {
    const { zeroSync } = await importStore();
    expect(() => zeroSync.forgetDevice("dev-x")).not.toThrow();
    expect(instances).toHaveLength(0);
  });

  it("destroy() clears the reportClientStats interval", async () => {
    localStorage.setItem("friday:flag:use-zero", "1");
    vi.useFakeTimers();
    try {
      const { zeroSync } = await importStore();
      // Drain init's microtask queue.
      await vi.runAllTimersAsync().catch(() => {});
      expect(instances).toHaveLength(1);
      const z = instances[0];
      const callsBeforeDestroy = z.mutate.reportClientStats.mock.calls.length;
      zeroSync.destroy();
      // Advance 6 minutes; the cleared interval should not fire.
      vi.advanceTimersByTime(6 * 60 * 1000);
      expect(z.mutate.reportClientStats.mock.calls.length).toBe(
        callsBeforeDestroy,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
