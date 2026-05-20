/**
 * @vitest-environment jsdom
 *
 * Unit tests for the Zero sync store boundary. The real `@rocicorp/zero`
 * client opens a live WS connection and only resolves in a browser
 * context — we mock it here to pin our store's contract:
 *
 *   1. Browser/SSR gating: `useZero()` is true under `browser`, false
 *      otherwise. Post-Phase 5 there's no flag — Zero is the only data
 *      path the dashboard knows how to drive.
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
      updateSettings: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      createTicket: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      updateTicket: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      addTicketComment: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      addTicketRelation: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      linkTicketExternal: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      createMemoryEntry: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      updateMemoryEntry: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      deleteMemoryEntry: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      createSchedule: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      updateSchedule: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      deleteSchedule: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      installApp: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      uninstallApp: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      reloadApp: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      archiveAgent: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      cancelQueued: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      abortTurn: vi.fn(() => ({
        client: Promise.resolve({ type: "success" }),
        server: Promise.resolve({ type: "success" }),
      })),
      sendUserMessage: vi.fn(() => ({
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
        ticket_comments: makeQueryProxy(),
        ticket_relations: makeQueryProxy(),
        ticket_external_links: makeQueryProxy(),
        schedules: makeQueryProxy(),
        memory_entries: makeQueryProxy(),
        apps: makeQueryProxy(),
        mail: makeQueryProxy(),
        client_devices: makeQueryProxy(),
        settings: makeQueryProxy(),
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

describe("useZero", () => {
  it("returns true in a browser context (Zero is the only data path post-Phase 5)", async () => {
    const { useZero, useZeroSidebar } = await importStore();
    expect(useZero()).toBe(true);
    // Phase 2 alias retained for callers still typing the old name.
    expect(useZeroSidebar()).toBe(true);
  });

  it("returns false outside a browser context (SSR has no WS / IDB)", async () => {
    // The default test setup mocks `$app/environment` to `{ browser:
    // true }`; flip it for this one test to assert the SSR branch.
    vi.doMock("$app/environment", () => ({ browser: false }));
    vi.resetModules();
    const store = await import("./zero.svelte.js");
    expect(store.useZero()).toBe(false);
    // Restore the module-level mock so subsequent tests in this file
    // continue to see `browser: true`.
    vi.doMock("$app/environment", () => ({ browser: true }));
    vi.resetModules();
  });
});

describe("ZeroSyncStore initialization", () => {
  it("fetches /api/sync/refresh and constructs Zero with the device id", async () => {
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
    // Local-first contract (plan §39): Zero persists its replica to
    // IndexedDB across reloads. `kvStore: "mem"` was the deferred-Phase-6
    // bug that broke offline access + made every reload re-sync from the
    // network; `'idb'` is the load-bearing fix.
    expect(opts.kvStore).toBe("idb");
  });
});

describe("toAgentInfo mapping (via materialize update)", () => {
  it("converts snake_case ZeroAgentRow → camelCase AgentInfo with ISO timestamps", async () => {
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
  it("bindBlocksFor materializes a per-agent query with status filter + 90d retention bound + ts ordering (no row limit — plan §39 local-first)", async () => {
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    expect(instances).toHaveLength(1);
    const z = instances[0];

    // The background-sync prime (`#bindAllBlocksBackground`) calls
    // `.where` on the SAME query proxy during init, so snapshot the
    // call count before invoking bindBlocksFor and assert against the
    // delta — otherwise this test couples to the background prime's
    // internal call shape.
    const blocksQuery = z.query.blocks as {
      __calls: Array<{ method: string; args: unknown[] }>;
    };
    const baseline = blocksQuery.__calls.length;

    const before = Date.now();
    zeroSync.bindBlocksFor("friday");
    expect(zeroSync.blocksAgent).toBe("friday");

    // Local-first contract (plan §39 phase 1 + §40 retention):
    //   - filter streaming + cancel_requested in-flight markers
    //   - filter ts > now - 90 days (client retention bound; server
    //     keeps everything beyond that for the jump-to-message path)
    //   - order by ts DESC for the chat scroller
    //   - NO `.limit(N)` — the local replica IS the source of truth;
    //     dropping the limit is what kills REST `?before=` pagination.
    const fgCalls = blocksQuery.__calls.slice(baseline);
    expect(fgCalls).toHaveLength(5);
    expect(fgCalls[0]).toEqual({
      method: "where",
      args: ["agent_name", "=", "friday"],
    });
    expect(fgCalls[1]).toEqual({
      method: "where",
      args: ["status", "!=", "streaming"],
    });
    expect(fgCalls[2]).toEqual({
      method: "where",
      args: ["status", "!=", "cancel_requested"],
    });
    expect(fgCalls[3].method).toBe("where");
    expect((fgCalls[3].args as unknown[]).slice(0, 2)).toEqual(["ts", ">"]);
    const cutoff = (fgCalls[3].args as unknown[])[2] as number;
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    expect(cutoff).toBeGreaterThanOrEqual(before - ninetyDaysMs - 5000);
    expect(cutoff).toBeLessThanOrEqual(Date.now() - ninetyDaysMs + 5);
    expect(fgCalls[4]).toEqual({
      method: "orderBy",
      args: ["ts", "desc"],
    });
    // No `.limit(N)` in the foreground bind — that's the architectural
    // contract this test is pinning.
    expect(fgCalls.some((c) => c.method === "limit")).toBe(false);
    const materializeCallCount = z.materialize.mock.calls.length;
    expect(materializeCallCount).toBeGreaterThan(0);
  });

  it("background-syncs all-agent blocks within the 90-day retention bound (plan §39 phase 2)", async () => {
    const { zeroSync: _zs } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    expect(instances).toHaveLength(1);
    const z = instances[0];

    // `#bindAllBlocksBackground` runs during #init and preloads (no
    // materialize) the full 90d window across every agent. This is
    // what makes a focus switch instant — the rows are already in
    // IndexedDB by the time the foreground per-agent bind fires.
    const blocksQuery = z.query.blocks as {
      __calls: Array<{ method: string; args: unknown[] }>;
    };
    // Background prime is the only blocks-query activity that fires
    // during init (bindBlocksFor is on-demand from chat focus).
    expect(blocksQuery.__calls).toEqual([
      { method: "where", args: ["status", "!=", "streaming"] },
      { method: "where", args: ["status", "!=", "cancel_requested"] },
      {
        method: "where",
        args: [
          "ts",
          ">",
          expect.any(Number) as unknown as number,
        ],
      },
    ]);
    // Preload was invoked for the background prime; materialize is
    // skipped because we don't want every agent's blocks in memory.
    const preloadCallCount = z.preload.mock.calls.length;
    expect(preloadCallCount).toBeGreaterThan(0);
  });

  it("rebinding to a new agent tears down the previous view", async () => {
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

  it("markRead is silently dropped before Zero has finished initializing", async () => {
    // Block the JWT fetch so #init() never reaches the `new Zero(...)`
    // line — chat shells call markRead unconditionally on focus and
    // MUST NOT throw if Zero isn't ready yet.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { zeroSync } = await importStore();
    expect(() => zeroSync.markRead("alpha", "blk-1")).not.toThrow();
    expect(instances).toHaveLength(0);
  });

  it("the Zero constructor receives `mutators` from createMutators", async () => {
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

  it("forgetDevice is silent before Zero has finished initializing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { zeroSync } = await importStore();
    expect(() => zeroSync.forgetDevice("dev-x")).not.toThrow();
    expect(instances).toHaveLength(0);
  });

  it("updateSettings forwards the partial patch to zero.mutate.updateSettings", async () => {
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    expect(instances).toHaveLength(1);
    const z = instances[0];
    zeroSync.updateSettings({ model: "claude-opus-4-7" });
    expect(z.mutate.updateSettings).toHaveBeenCalledTimes(1);
    const args = z.mutate.updateSettings.mock.calls[0][0] as {
      model?: string;
      watchdogRefork?: boolean;
      ts: number;
    };
    expect(args.model).toBe("claude-opus-4-7");
    expect("watchdogRefork" in args).toBe(false);
    expect(typeof args.ts).toBe("number");
  });

  it("updateSettings is silent before Zero has finished initializing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { zeroSync } = await importStore();
    expect(() =>
      zeroSync.updateSettings({ model: "claude-opus-4-7" }),
    ).not.toThrow();
    expect(instances).toHaveLength(0);
  });

  it("destroy() clears the reportClientStats interval", async () => {
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

describe("Phase 4.4: ticket mutator dispatch", () => {
  async function bootedZero() {
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    return { zeroSync, z: instances[0]! };
  }

  it("createTicket forwards args + stamps ts", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.createTicket({
      id: "FRI-9",
      title: "Hello",
      kind: "bug",
    });
    expect(z.mutate.createTicket).toHaveBeenCalledTimes(1);
    const args = z.mutate.createTicket.mock.calls[0][0] as {
      id: string;
      title: string;
      kind: string;
      ts: number;
    };
    expect(args.id).toBe("FRI-9");
    expect(args.title).toBe("Hello");
    expect(args.kind).toBe("bug");
    expect(typeof args.ts).toBe("number");
  });

  it("updateTicket forwards args + stamps ts", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.updateTicket({ id: "FRI-1", status: "done" });
    expect(z.mutate.updateTicket).toHaveBeenCalledTimes(1);
    const args = z.mutate.updateTicket.mock.calls[0][0] as {
      id: string;
      status?: string;
      ts: number;
    };
    expect(args.id).toBe("FRI-1");
    expect(args.status).toBe("done");
    expect(typeof args.ts).toBe("number");
  });

  it("addTicketComment forwards args + stamps ts", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.addTicketComment({
      id: "uuid-1",
      ticketId: "FRI-1",
      author: "alice",
      body: "looks good",
    });
    expect(z.mutate.addTicketComment).toHaveBeenCalledTimes(1);
    const args = z.mutate.addTicketComment.mock.calls[0][0] as {
      id: string;
      ticketId: string;
      author: string;
      body: string;
      ts: number;
    };
    expect(args).toMatchObject({
      id: "uuid-1",
      ticketId: "FRI-1",
      author: "alice",
      body: "looks good",
    });
    expect(typeof args.ts).toBe("number");
  });

  it("addTicketRelation forwards args (no ts — relations don't carry one)", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.addTicketRelation({
      parentId: "FRI-1",
      childId: "FRI-2",
      kind: "blocks",
    });
    const args = z.mutate.addTicketRelation.mock.calls[0][0] as {
      parentId: string;
      childId: string;
      kind: string;
    };
    expect(args).toEqual({
      parentId: "FRI-1",
      childId: "FRI-2",
      kind: "blocks",
    });
    // No ts stamped — ticket_relations has no timestamp column.
    expect("ts" in args).toBe(false);
  });

  it("linkTicketExternal forwards args + stamps ts (becomes linked_at server-side)", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.linkTicketExternal({
      ticketId: "FRI-1",
      system: "linear",
      externalId: "LIN-7",
      url: "https://linear.app/x/LIN-7",
    });
    const args = z.mutate.linkTicketExternal.mock.calls[0][0] as {
      ticketId: string;
      system: string;
      externalId: string;
      url?: string;
      ts: number;
    };
    expect(args).toMatchObject({
      ticketId: "FRI-1",
      system: "linear",
      externalId: "LIN-7",
      url: "https://linear.app/x/LIN-7",
    });
    expect(typeof args.ts).toBe("number");
  });

  it("all ticket mutators are silent before Zero has finished initializing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { zeroSync } = await importStore();
    expect(() =>
      zeroSync.createTicket({ id: "FRI-1", title: "x" }),
    ).not.toThrow();
    expect(() => zeroSync.updateTicket({ id: "FRI-1" })).not.toThrow();
    expect(() =>
      zeroSync.addTicketComment({
        id: "u",
        ticketId: "FRI-1",
        author: "a",
        body: "b",
      }),
    ).not.toThrow();
    expect(() =>
      zeroSync.addTicketRelation({
        parentId: "FRI-1",
        childId: "FRI-2",
        kind: "blocks",
      }),
    ).not.toThrow();
    expect(() =>
      zeroSync.linkTicketExternal({
        ticketId: "FRI-1",
        system: "linear",
        externalId: "LIN-1",
      }),
    ).not.toThrow();
  });
});

describe("Phase 4.5: memory mutator dispatch", () => {
  async function bootedZero() {
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    return { zeroSync, z: instances[0]! };
  }

  it("createMemoryEntry forwards args + stamps ts", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.createMemoryEntry({
      id: "my-note",
      title: "My Note",
      content: "Body",
      tags: ["a", "b"],
      createdBy: "user",
    });
    expect(z.mutate.createMemoryEntry).toHaveBeenCalledTimes(1);
    const args = z.mutate.createMemoryEntry.mock.calls[0][0] as {
      id: string;
      title: string;
      content: string;
      tags: string[];
      createdBy: string;
      ts: number;
    };
    expect(args).toMatchObject({
      id: "my-note",
      title: "My Note",
      content: "Body",
      tags: ["a", "b"],
      createdBy: "user",
    });
    expect(typeof args.ts).toBe("number");
  });

  it("updateMemoryEntry forwards partial patch + stamps ts", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.updateMemoryEntry({ id: "x", title: "new" });
    const args = z.mutate.updateMemoryEntry.mock.calls[0][0] as {
      id: string;
      title?: string;
      ts: number;
    };
    expect(args.id).toBe("x");
    expect(args.title).toBe("new");
    expect(typeof args.ts).toBe("number");
  });

  it("deleteMemoryEntry forwards id + stamps ts", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.deleteMemoryEntry({ id: "to-delete" });
    const args = z.mutate.deleteMemoryEntry.mock.calls[0][0] as {
      id: string;
      ts: number;
    };
    expect(args.id).toBe("to-delete");
    expect(typeof args.ts).toBe("number");
  });

  it("all memory mutators are silent before Zero has finished initializing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { zeroSync } = await importStore();
    expect(() =>
      zeroSync.createMemoryEntry({
        id: "x",
        title: "X",
        content: "",
        tags: [],
        createdBy: "u",
      }),
    ).not.toThrow();
    expect(() => zeroSync.updateMemoryEntry({ id: "x" })).not.toThrow();
    expect(() => zeroSync.deleteMemoryEntry({ id: "x" })).not.toThrow();
  });
});

describe("Phase 4.6: schedule mutator dispatch", () => {
  async function bootedZero() {
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    return { zeroSync, z: instances[0]! };
  }

  it("createSchedule forwards args + stamps ts", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.createSchedule({
      name: "daily",
      cron: "0 8 * * *",
      taskPrompt: "Summarize",
    });
    expect(z.mutate.createSchedule).toHaveBeenCalledTimes(1);
    const args = z.mutate.createSchedule.mock.calls[0][0] as {
      name: string;
      cron?: string;
      taskPrompt: string;
      ts: number;
    };
    expect(args.name).toBe("daily");
    expect(args.cron).toBe("0 8 * * *");
    expect(args.taskPrompt).toBe("Summarize");
    expect(typeof args.ts).toBe("number");
  });

  it("updateSchedule forwards partial patch + stamps ts", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.updateSchedule({ name: "daily", cron: "0 9 * * *" });
    const args = z.mutate.updateSchedule.mock.calls[0][0] as {
      name: string;
      cron?: string | null;
      ts: number;
    };
    expect(args.name).toBe("daily");
    expect(args.cron).toBe("0 9 * * *");
    expect(typeof args.ts).toBe("number");
  });

  it("updateSchedule supports null to clear cron/runAt", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.updateSchedule({ name: "x", cron: null });
    const args = z.mutate.updateSchedule.mock.calls[0][0] as {
      cron?: string | null;
    };
    expect(args.cron).toBeNull();
  });

  it("deleteSchedule forwards name + stamps ts", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.deleteSchedule({ name: "to-delete" });
    const args = z.mutate.deleteSchedule.mock.calls[0][0] as {
      name: string;
      ts: number;
    };
    expect(args.name).toBe("to-delete");
    expect(typeof args.ts).toBe("number");
  });

  it("all schedule mutators are silent before Zero has finished initializing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { zeroSync } = await importStore();
    expect(() =>
      zeroSync.createSchedule({ name: "x", taskPrompt: "X" }),
    ).not.toThrow();
    expect(() => zeroSync.updateSchedule({ name: "x" })).not.toThrow();
    expect(() => zeroSync.deleteSchedule({ name: "x" })).not.toThrow();
  });
});

describe("Phase 4.7: app mutator dispatch", () => {
  async function bootedZero() {
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    return { zeroSync, z: instances[0]! };
  }

  it("installApp forwards id + folderPath + stamps ts", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.installApp({
      id: "my-app",
      folderPath: "/Users/x/.friday/apps/my-app",
    });
    expect(z.mutate.installApp).toHaveBeenCalledTimes(1);
    const args = z.mutate.installApp.mock.calls[0][0] as {
      id: string;
      folderPath: string;
      ts: number;
    };
    expect(args.id).toBe("my-app");
    expect(args.folderPath).toBe("/Users/x/.friday/apps/my-app");
    expect(typeof args.ts).toBe("number");
  });

  it("uninstallApp forwards id + stamps ts", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.uninstallApp({ id: "to-uninstall" });
    const args = z.mutate.uninstallApp.mock.calls[0][0] as {
      id: string;
      ts: number;
    };
    expect(args.id).toBe("to-uninstall");
    expect(typeof args.ts).toBe("number");
  });

  it("reloadApp forwards id + stamps ts", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.reloadApp({ id: "to-reload" });
    const args = z.mutate.reloadApp.mock.calls[0][0] as {
      id: string;
      ts: number;
    };
    expect(args.id).toBe("to-reload");
    expect(typeof args.ts).toBe("number");
  });

  it("all app mutators are silent before Zero has finished initializing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { zeroSync } = await importStore();
    expect(() =>
      zeroSync.installApp({ id: "x", folderPath: "/x" }),
    ).not.toThrow();
    expect(() => zeroSync.uninstallApp({ id: "x" })).not.toThrow();
    expect(() => zeroSync.reloadApp({ id: "x" })).not.toThrow();
  });
});

describe("Phase 4.8: archiveAgent mutator dispatch", () => {
  async function bootedZero() {
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    return { zeroSync, z: instances[0]! };
  }

  it("forwards name + reason + stamps ts", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.archiveAgent({ name: "builder-xyz", reason: "completed" });
    expect(z.mutate.archiveAgent).toHaveBeenCalledTimes(1);
    const args = z.mutate.archiveAgent.mock.calls[0][0] as {
      name: string;
      reason: string;
      ts: number;
    };
    expect(args.name).toBe("builder-xyz");
    expect(args.reason).toBe("completed");
    expect(typeof args.ts).toBe("number");
  });

  it("defaults reason to 'abandoned' when omitted (matches /archive slash-command default)", async () => {
    const { zeroSync, z } = await bootedZero();
    zeroSync.archiveAgent({ name: "ghost" });
    const args = z.mutate.archiveAgent.mock.calls[0][0] as {
      reason: string;
    };
    expect(args.reason).toBe("abandoned");
  });

  it("is silent before Zero has finished initializing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { zeroSync } = await importStore();
    expect(() => zeroSync.archiveAgent({ name: "x" })).not.toThrow();
  });
});

describe("Phase 4.9: cancelQueued wrapper (fast-path + mutator)", () => {
  async function bootedZero() {
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    return { zeroSync, z: instances[0]! };
  }

  function seedQueuedBlock(zeroSync: {
    blocks: Array<{
      id: string;
      block_id: string;
      turn_id: string;
      agent_name: string;
      role: string;
      source: string | null;
      status: string;
      content_json: unknown;
    }>;
  }) {
    zeroSync.blocks = [
      {
        id: "blk-cancel-fixture",
        block_id: "blk-queued-1",
        turn_id: "turn-q1",
        agent_name: "agent-a",
        role: "user",
        source: "user_chat",
        status: "queued",
        content_json: { text: "hello world" },
      },
    ];
  }

  function stubFastPath(text: string, ok = true) {
    // Type the inner fn with fetch's signature so vitest's mock-call
    // tuple narrows to `[RequestInfo | URL, RequestInit?]` — without
    // it `.mock.calls[0]` is `[]` and tests indexing `[0]`/`[1]` to
    // assert the URL + body fail to typecheck.
    const spy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok, text }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("returns null when no queued block matches the turn id (already dispatched / cleared)", async () => {
    const { zeroSync } = await bootedZero();
    // No blocks seeded — the wrapper bails before even calling the
    // fast-path or the mutator.
    const out = await zeroSync.cancelQueued("turn-missing");
    expect(out).toBeNull();
  });

  it("POSTs the daemon fast-path with the block_id and returns recovered text", async () => {
    const { zeroSync, z } = await bootedZero();
    seedQueuedBlock(zeroSync as never);
    const fetchSpy = stubFastPath("hello world");
    const out = await zeroSync.cancelQueued("turn-q1");
    expect(out).toBe("hello world");
    // First fetch call: the fast-path endpoint with the right body.
    const first = fetchSpy.mock.calls[0];
    expect(first?.[0]).toBe("/api/internal/cancel-queued");
    const init = first?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ block_id: "blk-queued-1" });
    // Mutator dispatched with the bigserial id (not the block_id).
    expect(z.mutate.cancelQueued).toHaveBeenCalledTimes(1);
    const args = z.mutate.cancelQueued.mock.calls[0][0] as {
      id: string;
      ts: number;
    };
    expect(args.id).toBe("blk-cancel-fixture");
    expect(typeof args.ts).toBe("number");
  });

  it("falls back to content_json from the local Zero snapshot when fast-path fails", async () => {
    // Daemon-down resilience: the mutator must still fire (durable
    // cross-device propagation), and the recovered text comes from
    // the local Zero row's content_json.
    const { zeroSync, z } = await bootedZero();
    seedQueuedBlock(zeroSync as never);
    const fetchSpy = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const out = await zeroSync.cancelQueued("turn-q1");
    expect(out).toBe("hello world");
    expect(z.mutate.cancelQueued).toHaveBeenCalledTimes(1);
  });

  it("is silent before Zero has finished initializing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { zeroSync } = await importStore();
    await expect(zeroSync.cancelQueued("turn-x")).resolves.toBeNull();
  });
});

describe("Phase 4.10: abortTurn wrapper (fast-path + mutator)", () => {
  async function bootedZero() {
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    return { zeroSync, z: instances[0]! };
  }

  function seedUserBlock(zeroSync: {
    blocks: Array<{
      id: string;
      block_id: string;
      turn_id: string;
      agent_name: string;
      role: string;
      source: string | null;
      status: string;
      content_json: unknown;
    }>;
  }) {
    zeroSync.blocks = [
      {
        id: "blk-abort-fixture",
        block_id: "blk-inflight",
        turn_id: "turn-stop",
        agent_name: "friday",
        role: "user",
        source: "user_chat",
        status: "complete",
        content_json: { text: "stop me" },
      },
    ];
  }

  it("still fires the daemon fast-path even when no matching user block is in Zero's window", async () => {
    // Regression — previously this path returned `false` early without
    // hitting the daemon, which silently no-op'd the Stop button any
    // time a long turn (lots of tool calls) had pushed the user_chat
    // row out of the 50-row Zero materialization. The daemon endpoint
    // only needs `turn_id`; it resolves the live worker server-side.
    const { zeroSync } = await bootedZero();
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, aborted: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await expect(zeroSync.abortTurn("turn-nope")).resolves.toBe(true);
    const fastPath = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes("/api/internal/abort-turn"),
    );
    expect(fastPath).toBeDefined();
    expect(JSON.parse((fastPath![1] as RequestInit).body as string)).toEqual({
      turn_id: "turn-nope",
    });
  });

  it("POSTs the daemon fast-path with the turn_id AND dispatches the mutator with the bigserial id", async () => {
    const { zeroSync, z } = await bootedZero();
    seedUserBlock(zeroSync as never);
    // Annotate args so the mock-call tuple narrows to `[input, init?]`
    // — bare `vi.fn(async () => ...)` makes `mock.calls[0]` an empty
    // tuple and the `c[0]` / `[1]` accesses below fail to typecheck.
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, aborted: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const out = await zeroSync.abortTurn("turn-stop");
    expect(out).toBe(true);

    // Fast-path POSTed with turn_id (not block_id — the daemon's
    // findAgentByTurnId looks up the agent via live-worker map).
    const fastPathCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes("/api/internal/abort-turn"),
    );
    expect(fastPathCall).toBeDefined();
    const init = fastPathCall![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ turn_id: "turn-stop" });

    // Mutator dispatched with the bigserial id.
    expect(z.mutate.abortTurn).toHaveBeenCalledTimes(1);
    const args = z.mutate.abortTurn.mock.calls[0][0] as {
      id: string;
      ts: number;
    };
    expect(args.id).toBe("blk-abort-fixture");
    expect(typeof args.ts).toBe("number");
  });

  it("still dispatches the mutator even when the fast-path fails (daemon-down resilience)", async () => {
    // Plan §5: mutator commits durably to Postgres; the LISTEN-path's
    // boot-recovery scan picks up the abort_requested row once the
    // daemon returns.
    const { zeroSync, z } = await bootedZero();
    seedUserBlock(zeroSync as never);
    const fetchSpy = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const out = await zeroSync.abortTurn("turn-stop");
    expect(out).toBe(true);
    expect(z.mutate.abortTurn).toHaveBeenCalledTimes(1);
  });

  it("is silent before Zero has finished initializing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { zeroSync } = await importStore();
    await expect(zeroSync.abortTurn("turn-x")).resolves.toBe(false);
  });
});

describe("Phase 4.11b: sendUserMessage wrapper", () => {
  async function bootedZero() {
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    return { zeroSync, z: instances[0]! };
  }

  it("generates a UUID + t_-prefixed turn_id and dispatches the mutator with the full args", async () => {
    const { zeroSync, z } = await bootedZero();
    const out = await zeroSync.sendUserMessage({
      agent: "friday",
      text: "hello agent",
    });
    expect(out).not.toBeNull();
    expect(out!.blockId.length).toBeGreaterThan(0);
    expect(out!.turnId).toBe(`t_${out!.blockId}`);

    expect(z.mutate.sendUserMessage).toHaveBeenCalledTimes(1);
    const args = z.mutate.sendUserMessage.mock.calls[0][0] as {
      id: string;
      turnId: string;
      agentName: string;
      text: string;
      attachments?: unknown;
      ts: number;
    };
    expect(args.id).toBe(out!.blockId);
    expect(args.turnId).toBe(out!.turnId);
    expect(args.agentName).toBe("friday");
    expect(args.text).toBe("hello agent");
    expect(typeof args.ts).toBe("number");
    expect(args.attachments).toBeUndefined();
  });

  it("forwards attachments verbatim to the mutator", async () => {
    const { zeroSync, z } = await bootedZero();
    const attachments = [
      { sha256: "a".repeat(64), filename: "shot.png", mime: "image/png" },
    ];
    await zeroSync.sendUserMessage({
      agent: "friday",
      text: "see this",
      attachments,
    });
    const args = z.mutate.sendUserMessage.mock.calls[0][0] as {
      attachments?: Array<{ sha256: string }>;
    };
    expect(args.attachments).toEqual(attachments);
  });

  it("returns null when the server-side mutator throws (PK collision / Zero error)", async () => {
    // Server-side mutator failure must surface as null so the
    // send-queue retries on the next flush rather than treating
    // the dispatch as successful.
    const { zeroSync, z } = await bootedZero();
    z.mutate.sendUserMessage = vi.fn(() => ({
      client: Promise.resolve({ type: "success" }),
      server: Promise.reject(new Error("pk_collision")),
    }));
    const out = await zeroSync.sendUserMessage({
      agent: "friday",
      text: "boom",
    });
    expect(out).toBeNull();
  });

  it("returns null before Zero has finished initializing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { zeroSync } = await importStore();
    await expect(
      zeroSync.sendUserMessage({ agent: "friday", text: "x" }),
    ).resolves.toBeNull();
  });
});
