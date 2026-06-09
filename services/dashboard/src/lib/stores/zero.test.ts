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
  clientGroupID: Promise<string>;
  mutate: Record<string, ReturnType<typeof vi.fn>>;
  // Capture the constructor args so tests can inspect them.
  __ctorOpts: Record<string, unknown>;
  // FRI-121: connection mock
  connection: {
    state: {
      subscribe: ReturnType<typeof vi.fn>;
      current: { name: string };
    };
    connect: ReturnType<typeof vi.fn>;
  };
  /** Fire a connection-state change on all subscribers for this instance. */
  __emitConnState: (state: { name: string; reason?: unknown }) => void;
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
    // FRI-161: the store awaits `this.#zero.clientGroupID` in `#init` (it is a
    // Promise<ClientGroupID> resolved locally during IndexedDB open) to read
    // the per-client-group warm-replica flag before binding blocks. Default to
    // a fixed test id; warm-reload tests pre-seed localStorage with this value.
    clientGroupID: Promise<string> = Promise.resolve("test-cg");
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
    connection: MockedZero["connection"];
    __emitConnState: MockedZero["__emitConnState"];
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
        evolve_proposals: makeQueryProxy(),
        read_cursors: makeQueryProxy(),
      };
      // FRI-121: connection mock — subscribe captures the listener and fires
      // with 'connected' immediately (matches Zero's BehaviorSubject-like API).
      const connListeners: Array<(s: { name: string; reason?: unknown }) => void> = [];
      this.connection = {
        state: {
          current: { name: "connected" },
          subscribe: vi.fn((listener: (s: { name: string; reason?: unknown }) => void) => {
            connListeners.push(listener);
            listener({ name: "connected" });
            return () => {
              const idx = connListeners.indexOf(listener);
              if (idx !== -1) connListeners.splice(idx, 1);
            };
          }),
        },
        connect: vi.fn(),
      };
      this.__emitConnState = (state: { name: string; reason?: unknown }) => {
        for (const l of connListeners) l(state);
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
  const fetchSpy = vi.fn(
    async () =>
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
  // First-import cost in this file is dominated by the cold load of
  // `@rocicorp/zero` + its transitive Drizzle/PG imports. On a busy
  // CI runner that can edge past Vitest's default 5s ceiling even
  // though the work inside the test body is sync. Bumping just this
  // case (subsequent tests benefit from the warm module cache and
  // run in <200ms).
  it("returns true in a browser context (Zero is the only data path post-Phase 5)", async () => {
    const { useZero, useZeroSidebar } = await importStore();
    expect(useZero()).toBe(true);
    // Phase 2 alias retained for callers still typing the old name.
    expect(useZeroSidebar()).toBe(true);
  }, 30_000);

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
                  session_count: 3,
                  created_at: 1_700_000_000_000,
                  updated_at: 1_700_000_001_000,
                },
                {
                  name: "beta",
                  type: "bare",
                  status: "idle",
                  session_id: null,
                  session_count: 0,
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
      sessionCount: 3,
    });
    expect(chat.agents[1].sessionId).toBeUndefined();
    expect(chat.agents[1].sessionCount).toBe(0);
    expect(chat.agents[0].createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(chat.agents[1].updatedAt).toBe(new Date(1_700_000_002_000).toISOString());

    // Restore for other tests.
    (mockedZero as unknown as { Zero: unknown }).Zero = origCtor;
  });
});

describe("#bindAgents query (FRI-101 regression): no status filter", () => {
  // Regression for the bug where `#bindAgents` filtered `status != "archived"`
  // at the Zero query level. That hid archived rows from the client entirely,
  // so the Sidebar's "Show archived" toggle had nothing to reveal and the
  // Settings page's per-app agent list silently dropped archived entries.
  // The Sidebar owns archive/inactive visibility client-side via the
  // showArchived + showInactive toggles; the data layer must hand it the
  // full agent list.
  it("registers no status-based .where on the agents query", async () => {
    await importStore();
    await new Promise((r) => setTimeout(r, 30));
    expect(instances).toHaveLength(1);
    const z = instances[0];
    const agentsQuery = z.query.agents as {
      __calls: Array<{ method: string; args: unknown[] }>;
    };
    const statusFilters = agentsQuery.__calls.filter(
      (c) => c.method === "where" && Array.isArray(c.args) && c.args[0] === "status",
    );
    expect(statusFilters).toEqual([]);
  });

  it("archived rows reach chat.agents end-to-end (Sidebar toggle has data)", async () => {
    const mockedZero = await import("@rocicorp/zero");
    const ZeroCtor = mockedZero.Zero as unknown as new (
      opts: Record<string, unknown>,
    ) => MockedZero;
    const origCtor = ZeroCtor;
    const patched = function (opts: Record<string, unknown>) {
      const inst = new origCtor(opts);
      let nth = 0;
      inst.materialize = vi.fn(() => {
        const isFirst = nth === 0;
        nth += 1;
        return {
          data: isFirst
            ? [
                {
                  name: "live",
                  type: "builder",
                  status: "working",
                  session_id: "sess-live",
                  session_count: 1,
                  created_at: 1_700_000_000_000,
                  updated_at: 1_700_000_000_000,
                },
                {
                  name: "killed",
                  type: "helper",
                  status: "archived",
                  session_id: null,
                  session_count: 1,
                  created_at: 1_700_000_000_000,
                  updated_at: 1_700_000_001_000,
                },
                {
                  name: "broken",
                  type: "helper",
                  status: "error",
                  session_id: null,
                  session_count: 0,
                  created_at: 1_700_000_000_000,
                  updated_at: 1_700_000_002_000,
                },
              ]
            : [],
          addListener: vi.fn(() => () => {}),
          destroy: vi.fn(),
        };
      });
      return inst;
    };
    (mockedZero as unknown as { Zero: unknown }).Zero = patched;

    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));

    expect(zeroSync.agents).toHaveLength(3);
    const { chat } = await import("./chat.svelte.js");
    expect(chat.agents.map((a) => a.name).sort()).toEqual(["broken", "killed", "live"]);
    expect(chat.agents.find((a) => a.name === "killed")?.status).toBe("archived");
    expect(chat.agents.find((a) => a.name === "broken")?.status).toBe("error");

    (mockedZero as unknown as { Zero: unknown }).Zero = origCtor;
  });
});

describe("blocksRetentionCutoff (Zero query-cache stability)", () => {
  // The blocks `where("ts", ">", …)` lower bound must be STABLE across page
  // refreshes within a day. A raw `Date.now() - 90d` changes every load, so
  // Zero sees a new query literal each time and re-streams the entire blocks
  // view group from the server (the "Slow query materialization" 5–12s on
  // every refresh). Day-quantization is the fix; these pin it.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an identical cutoff for two loads within the same UTC day (cache reuse)", async () => {
    vi.useFakeTimers();
    const { blocksRetentionCutoff } = await importStore();
    vi.setSystemTime(new Date("2026-06-01T00:07:00.000Z"));
    const earlyInDay = blocksRetentionCutoff();
    vi.setSystemTime(new Date("2026-06-01T23:51:00.000Z"));
    const lateInDay = blocksRetentionCutoff();
    expect(lateInDay).toBe(earlyInDay);
  });

  it("is floored to a UTC-day boundary", async () => {
    vi.useFakeTimers();
    const { blocksRetentionCutoff, DAY_MS } = await importStore();
    vi.setSystemTime(new Date("2026-06-01T13:22:47.123Z"));
    expect(blocksRetentionCutoff() % DAY_MS).toBe(0);
  });

  it("advances by exactly one day across a day boundary", async () => {
    vi.useFakeTimers();
    const { blocksRetentionCutoff, DAY_MS } = await importStore();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    const day1 = blocksRetentionCutoff();
    vi.setSystemTime(new Date("2026-06-02T12:00:00.000Z"));
    const day2 = blocksRetentionCutoff();
    expect(day2 - day1).toBe(DAY_MS);
  });

  it("stays within the 90-day retention window (never older than 91 days)", async () => {
    vi.useFakeTimers();
    const { blocksRetentionCutoff, BLOCKS_RETENTION_MS, DAY_MS } = await importStore();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    const age = Date.now() - blocksRetentionCutoff();
    expect(age).toBeGreaterThanOrEqual(BLOCKS_RETENTION_MS);
    expect(age).toBeLessThan(BLOCKS_RETENTION_MS + DAY_MS);
  });

  // FRI-161 AC 2: the narrow cold-start foreground bound is its own exported
  // helper and must carry the SAME day-quantization stability property as the
  // retention cutoff, while sitting 2–3 days in the past. Asserted directly
  // against `coldStartCutoff`'s own return value (not transitively through a
  // bind), so a regression to `Math.round`, a wrong window multiple, or a
  // raw `Date.now()` literal is caught here at the atomic level.
  it("coldStartCutoff is day-quantized and 2–3 days old", async () => {
    vi.useFakeTimers();
    const { coldStartCutoff, COLD_START_WINDOW_MS, DAY_MS } = await importStore();
    vi.setSystemTime(new Date("2026-06-01T13:22:47.123Z"));
    // Day-quantized — stable literal across same-day reloads (CVR reuse).
    expect(coldStartCutoff() % DAY_MS).toBe(0);
    // 2 days old at minimum (the window), and never more than one extra day
    // older from flooring to the UTC-day boundary.
    const age = Date.now() - coldStartCutoff();
    expect(age).toBeGreaterThanOrEqual(COLD_START_WINDOW_MS);
    expect(age).toBeLessThan(COLD_START_WINDOW_MS + DAY_MS);
  });

  it("coldStartCutoff is identical for two loads within the same UTC day (cache reuse)", async () => {
    vi.useFakeTimers();
    const { coldStartCutoff } = await importStore();
    vi.setSystemTime(new Date("2026-06-01T00:07:00.000Z"));
    const earlyInDay = coldStartCutoff();
    vi.setSystemTime(new Date("2026-06-01T23:51:00.000Z"));
    const lateInDay = coldStartCutoff();
    expect(lateInDay).toBe(earlyInDay);
  });

  // FRI-161 AC 11 rests entirely on `backfillChunkFloor` producing stable,
  // epoch-day-aligned chunk bounds. Pin the alignment at the atomic level so a
  // regression in the chunk grid is caught here, not only via the multi-chunk
  // backfill integration test.
  it("backfillChunkFloor aligns to the epoch chunk grid and is stable in-grid", async () => {
    const { backfillChunkFloor, BACKFILL_CHUNK_MS } = await importStore();
    // Floored to a chunk boundary.
    expect(backfillChunkFloor(Date.parse("2026-06-09T14:00:00.000Z")) % BACKFILL_CHUNK_MS).toBe(0);
    // Two timestamps in the same chunk floor to the same bound.
    const a = backfillChunkFloor(Date.parse("2026-06-09T00:07:00.000Z"));
    const b = backfillChunkFloor(Date.parse("2026-06-09T23:51:00.000Z"));
    expect(a).toBe(b);
    // The next chunk is exactly BACKFILL_CHUNK_MS later.
    const next = backfillChunkFloor(Date.parse("2026-06-10T12:00:00.000Z"));
    expect(next - a).toBe(BACKFILL_CHUNK_MS);
  });
});

describe("Phase 3.7: bindBlocksFor / unbindBlocks", () => {
  it("cold bindBlocksFor materializes a per-agent query with the NARROW 2-day day-quantized cold-start bound + ts ordering (no row limit, no all-agent init prime — FRI-161)", async () => {
    const { zeroSync, COLD_START_WINDOW_MS, DAY_MS } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    expect(instances).toHaveLength(1);
    const z = instances[0];

    // FRI-161: no all-agent prime fires during init anymore, so the blocks
    // query proxy has ZERO recorded calls before the foreground bind — the
    // foreground bind is the only blocks activity (AC 4 covers init quiet).
    const blocksQuery = z.query.blocks as {
      __calls: Array<{ method: string; args: unknown[] }>;
    };
    expect(blocksQuery.__calls).toEqual([]);

    const before = Date.now();
    zeroSync.bindBlocksFor("friday");
    expect(zeroSync.blocksAgent).toBe("friday");
    // Cold start: the foreground window is NARROW, so the honest-oldest /
    // pastLoading gates must see `blocksFullWindow === false`.
    expect(zeroSync.blocksFullWindow).toBe(false);

    const fgCalls = blocksQuery.__calls;
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
    // FRI-161: the cold bound is the NARROW 2-day window, still day-quantized
    // so the literal is stable across same-day reloads (CVR reuse).
    expect(cutoff % DAY_MS).toBe(0);
    // Flooring drops the bound by up to one day below `now - COLD_START_WINDOW`.
    expect(cutoff).toBeGreaterThanOrEqual(before - COLD_START_WINDOW_MS - DAY_MS);
    expect(cutoff).toBeLessThanOrEqual(Date.now() - COLD_START_WINDOW_MS);
    expect(fgCalls[4]).toEqual({
      method: "orderBy",
      args: ["ts", "desc"],
    });
    // No `.limit(N)` in the foreground bind — the architectural contract.
    expect(fgCalls.some((c) => c.method === "limit")).toBe(false);
    const materializeCallCount = z.materialize.mock.calls.length;
    expect(materializeCallCount).toBeGreaterThan(0);
  });

  it("warm reload binds the FULL 90-day window directly (no cold-start bound ever issued) — FRI-161 AC 10", async () => {
    // Pre-seed the per-client-group warm flag for the mocked clientGroupID
    // BEFORE importing the store, so `#init` reads it warm and every
    // foreground bind uses the full retention bound.
    localStorage.setItem("friday.zero.blocksBackfillComplete", "test-cg");

    const { zeroSync, blocksRetentionCutoff } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    const z = instances[0];
    const blocksQuery = z.query.blocks as {
      __calls: Array<{ method: string; args: unknown[] }>;
    };

    const fullCutoff = blocksRetentionCutoff();
    zeroSync.bindBlocksFor("friday");
    expect(zeroSync.blocksFullWindow).toBe(true);

    const tsBounds = blocksQuery.__calls.filter(
      (c) =>
        c.method === "where" &&
        (c.args as unknown[])[0] === "ts" &&
        (c.args as unknown[])[1] === ">",
    );
    // Exactly the full retention literal — never a cold-start-valued bound.
    expect(tsBounds).toHaveLength(1);
    expect((tsBounds[0].args as unknown[])[2]).toBe(fullCutoff);
  });

  it("no blocks preload or query is issued during the init batch (FRI-161 AC 4)", async () => {
    const { zeroSync: _zs } = await importStore();
    // Settle past init but well before the 10s no-foreground fallback.
    await new Promise((r) => setTimeout(r, 30));
    expect(instances).toHaveLength(1);
    const z = instances[0];
    const blocksQuery = z.query.blocks as {
      __calls: Array<{ method: string; args: unknown[] }>;
    };
    // The old all-agent prime fired 3 `.where` calls at init; under FRI-161
    // nothing touches the blocks query until a foreground bind or the
    // backfill triggers. First paint is not gated on a blocks hydration.
    expect(blocksQuery.__calls).toEqual([]);
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

  it("rebinding to the same agent doesn't re-materialize but does re-fire listeners", async () => {
    // Past-session → live navigation lands here: ChatShell remounts the
    // live view, chat.loadAgentTurns(agent) sets loadingInitial=true and
    // calls into this binder expecting the listener to fire applyZeroBlocks
    // (which flips loadingInitial back to false). Tearing the materialized
    // view down + re-materializing would flash the data and waste a zero-
    // cache round-trip, so the binder short-circuits the view work but
    // still fires the listener set so callers see a synthetic "current
    // snapshot" frame.
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));

    const z = instances[0];
    let materializeCount = 0;
    const row = {
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
      content_json: { text: "hi" },
      status: "complete",
      streaming: false,
      origin_mutation_id: null,
      ts: 1_000,
    };
    z.materialize = vi.fn(() => {
      materializeCount++;
      return {
        data: [row],
        addListener: vi.fn(() => () => {}),
        destroy: vi.fn(),
      };
    });

    const fired: Array<{ rows: number; resultType: string }> = [];
    zeroSync.onBlocksUpdate((rows, resultType) => {
      fired.push({ rows: rows.length, resultType });
    });
    const firedAtRegistration = fired.length;

    zeroSync.bindBlocksFor("friday");
    const materializeAfterFirstBind = materializeCount;
    const firedAfterFirstBind = fired.length;

    zeroSync.bindBlocksFor("friday");

    // Materialize was NOT called again — same-agent rebind keeps the view.
    expect(materializeCount).toBe(materializeAfterFirstBind);
    // But listeners DID fire again, with the current snapshot (1 row).
    expect(fired.length).toBe(firedAfterFirstBind + 1);
    expect(fired.at(-1)).toEqual({ rows: 1, resultType: "unknown" });
    // Sanity: the registration-time fire happened before either bind.
    expect(firedAtRegistration).toBe(1);
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

describe("FRI-161: tiered cold-start backfill", () => {
  // A controllable preload resolver: every `preload` call records its handle
  // and exposes resolve/reject so tests gate chunk sequencing manually
  // (per repo discipline: mock the IO boundary, leave reactivity real).
  type PreloadHandle = {
    args: unknown[];
    resolve: () => void;
    reject: (e: unknown) => void;
    cleanup: ReturnType<typeof vi.fn>;
  };

  /**
   * Patch the mocked Zero ctor so that:
   *  - `preload` returns controlled `complete` promises captured in `handles`,
   *    EXCEPT the per-agent foreground bind's preload (no `ttl` arg) which
   *    resolves immediately so it doesn't pollute the chunk handle list.
   *  - `materialize` captures the foreground view's listener so a test can
   *    drive `resultType === "complete"` (the backfill trigger).
   * Returns accessors for the captured state.
   */
  // The pristine (unpatched) ctor, captured the first time we patch so a
  // double-patch within one test (AC 11) doesn't capture an already-patched
  // ctor as its "original" and leak it past the suite.
  let pristineCtor: unknown = null;

  async function patchZeroForBackfill(): Promise<{
    handles: PreloadHandle[];
    blocksPreloadCalls: PreloadHandle[];
    fireForegroundComplete: () => void;
    materialize: () => ReturnType<typeof vi.fn>;
    queryCalls: () => Array<{ method: string; args: unknown[] }>;
    viewLifecycle: Array<{ event: "materialize" | "destroy"; seq: number }>;
  }> {
    const mockedZero = await import("@rocicorp/zero");
    if (pristineCtor === null) pristineCtor = mockedZero.Zero;
    const origCtor = pristineCtor as new (opts: Record<string, unknown>) => MockedZero;

    const handles: PreloadHandle[] = [];
    // Ordered log of materialize/destroy events across ALL blocks views, so
    // AC 9 can pin the swap ORDERING invariant directly: the wider view must
    // be materialized BEFORE the narrow view is destroyed. `unbindBlocks`'s
    // `blocks = []` write never notifies `#blocksListeners`, so an empty-frame
    // listener check alone cannot catch a destroy-before-materialize regression
    // — this lifecycle log makes the ordering observable.
    const viewLifecycle: Array<{ event: "materialize" | "destroy"; seq: number }> = [];
    let lifecycleSeq = 0;
    let foregroundListener: ((data: unknown, rt: string) => void) | null = null;
    // Cursor into the shared blocks-query `__calls` array so each captured
    // chunk records ONLY its own `.where` calls (the mock reuses one proxy
    // whose calls accumulate across every chain — slice per preload).
    let callsCursor = 0;

    const patched = function (opts: Record<string, unknown>) {
      const inst = new origCtor(opts);
      // preload: backfill chunks (called with a `{ttl}` 2nd arg) get
      // controlled resolvers; the foreground bind preload (1 arg) resolves
      // immediately.
      inst.preload = vi.fn((_q: unknown, second?: unknown) => {
        const blocksQuery = inst.query.blocks as {
          __calls: Array<{ method: string; args: unknown[] }>;
        };
        const cleanup = vi.fn();
        if (second === undefined) {
          // Foreground bind preload — not a chunk. Advance the cursor past
          // its calls so the next chunk capture excludes them.
          callsCursor = blocksQuery.__calls.length;
          return { cleanup, complete: Promise.resolve() };
        }
        let resolve!: () => void;
        let reject!: (e: unknown) => void;
        const complete = new Promise<void>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        // Swallow unhandled rejection — tests assert state, not the promise.
        complete.catch(() => {});
        // This chunk's own calls are those since the last cursor mark.
        const ownCalls = blocksQuery.__calls.slice(callsCursor).map((c) => c.args);
        callsCursor = blocksQuery.__calls.length;
        handles.push({
          args: ownCalls,
          resolve,
          reject,
          cleanup,
        });
        return { cleanup, complete };
      }) as unknown as MockedZero["preload"];
      // materialize: every view carries one row. The fields are a superset
      // valid for BOTH the agents mapping (`toAgentInfo` needs created_at /
      // updated_at) AND the blocks shape, so the init agent slice doesn't
      // throw on a blocks-only row. The non-empty data lets AC 9 distinguish
      // a legitimate snapshot from the `blocks = []` write `unbindBlocks`
      // would do. The LAST captured listener is the foreground blocks view's,
      // which a test fires `'complete'` on to trigger the backfill.
      const fgRow = {
        id: 1,
        name: "friday",
        type: "bare",
        status: "idle",
        session_id: null,
        session_count: 0,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        agent_name: "friday",
        ts: 1_000,
      } as unknown;
      inst.materialize = vi.fn(() => {
        viewLifecycle.push({ event: "materialize", seq: lifecycleSeq++ });
        return {
          data: [fgRow],
          addListener: vi.fn((l: (data: unknown, rt: string) => void) => {
            foregroundListener = l;
            return () => {};
          }),
          destroy: vi.fn(() => {
            viewLifecycle.push({ event: "destroy", seq: lifecycleSeq++ });
          }),
        };
      }) as unknown as MockedZero["materialize"];
      return inst;
    };
    (mockedZero as unknown as { Zero: unknown }).Zero = patched;
    restoreCtor = () => {
      (mockedZero as unknown as { Zero: unknown }).Zero = pristineCtor;
    };

    return {
      handles,
      // The chunk handles are exactly the `preload` calls captured (the
      // foreground bind preload resolves inline and is not pushed).
      get blocksPreloadCalls() {
        return handles;
      },
      fireForegroundComplete: () => {
        // Fire with the foreground view's row so 'complete' doesn't itself
        // look like an empty frame (AC 9 counts empty frames).
        if (foregroundListener)
          foregroundListener([{ id: 1, agent_name: "friday", ts: 1_000 }], "complete");
      },
      materialize: () => instances[0].materialize as ReturnType<typeof vi.fn>,
      queryCalls: () =>
        (instances[0].query.blocks as { __calls: Array<{ method: string; args: unknown[] }> })
          .__calls,
      viewLifecycle,
    };
  }

  // Restore the original (unpatched) Zero ctor after every test in this
  // suite so downstream suites see the default mock — `vi.resetModules()`
  // in the file-level afterEach re-evaluates the store but NOT the
  // `vi.mock("@rocicorp/zero")` factory, so a left-patched ctor would leak.
  let restoreCtor: (() => void) | null = null;
  afterEach(() => {
    if (restoreCtor) restoreCtor();
    restoreCtor = null;
    // Re-capture the pristine ctor next test: `vi.resetModules()` (file-level
    // afterEach) may re-evaluate the mocked `@rocicorp/zero` module, making a
    // cached reference stale.
    pristineCtor = null;
  });

  it("issues no backfill chunk until the first foreground 'complete'; then issues exactly one head chunk (FRI-161 AC 5 trigger)", async () => {
    const cap = await patchZeroForBackfill();
    const { zeroSync, DAY_MS } = await importStore();
    await new Promise((r) => setTimeout(r, 30));

    zeroSync.bindBlocksFor("friday");
    // Cold bind alone (resultType 'unknown') does NOT start the backfill.
    expect(cap.blocksPreloadCalls.length).toBe(0);
    expect(zeroSync.blocksBackfill).toBe("idle");

    cap.fireForegroundComplete();
    await Promise.resolve();
    await Promise.resolve();
    // Exactly one chunk (the head) is in flight; the next is gated on its
    // `complete` (controlled resolver, still pending).
    expect(cap.blocksPreloadCalls.length).toBe(1);
    expect(zeroSync.blocksBackfill).toBe("running");

    // Head chunk: open-ended (`ts > B_head`, day-quantized floor of now), no
    // `<=` bound. Pin the EXACT lower bound, not just "is day-aligned": it must
    // equal today's UTC-day floor so warm reloads reuse the same CVR literal.
    // (Same ±1-day midnight-crossing slack convention as the retention-cutoff
    // tests above; the backfill is issued synchronously after the trigger, so
    // `Date.now()` here floors to the same day the store used.)
    const head = cap.blocksPreloadCalls[0].args;
    const tsGt = head.find((a) => (a as unknown[])[0] === "ts" && (a as unknown[])[1] === ">");
    const tsLe = head.find((a) => (a as unknown[])[0] === "ts" && (a as unknown[])[1] === "<=");
    const expectedHeadFloor = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    expect(tsGt, "head chunk must carry an exact day-floored `ts >` lower bound").toEqual([
      "ts",
      ">",
      expectedHeadFloor,
    ]);
    expect(tsLe, "head chunk must be open-ended (no `ts <=` upper bound)").toBeUndefined();
  });

  it("advances to the next (closed) chunk only after the previous chunk's complete resolves (FRI-161 AC 5 sequencing)", async () => {
    const cap = await patchZeroForBackfill();
    const { zeroSync, BACKFILL_CHUNK_MS } = await importStore();
    await new Promise((r) => setTimeout(r, 30));

    zeroSync.bindBlocksFor("friday");
    cap.fireForegroundComplete();
    await Promise.resolve();
    await Promise.resolve();
    expect(cap.blocksPreloadCalls.length).toBe(1);
    const bHead = (
      cap.blocksPreloadCalls[0].args.find(
        (a) => (a as unknown[])[0] === "ts" && (a as unknown[])[1] === ">",
      ) as unknown[]
    )[2] as number;

    // Resolve the head; the second (closed) chunk must now be issued.
    cap.blocksPreloadCalls[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(cap.blocksPreloadCalls.length).toBe(2);

    const second = cap.blocksPreloadCalls[1].args;
    const gt = second.find((a) => (a as unknown[])[0] === "ts" && (a as unknown[])[1] === ">");
    const le = second.find((a) => (a as unknown[])[0] === "ts" && (a as unknown[])[1] === "<=");
    expect((gt as unknown[])[2]).toBe(bHead - BACKFILL_CHUNK_MS);
    expect((le as unknown[])[2]).toBe(bHead);
  });

  it("covers the full retention window and marks backfill complete + persists the warm flag (FRI-161 AC 6)", async () => {
    const cap = await patchZeroForBackfill();
    const { zeroSync, blocksRetentionCutoff } = await importStore();
    await new Promise((r) => setTimeout(r, 30));

    zeroSync.bindBlocksFor("friday");
    cap.fireForegroundComplete();
    // Drain the chunk loop: resolve each chunk as it appears until done.
    for (let guard = 0; guard < 200 && zeroSync.blocksBackfill === "running"; guard++) {
      await Promise.resolve();
      await Promise.resolve();
      const pending = cap.blocksPreloadCalls.filter((h) => h.resolve);
      // Resolve the most recently issued, still-unresolved chunk.
      const last = cap.blocksPreloadCalls[cap.blocksPreloadCalls.length - 1];
      if (last) last.resolve();
      void pending;
    }
    await Promise.resolve();
    expect(zeroSync.blocksBackfill).toBe("complete");

    // Oldest issued chunk's lower bound reaches at or below the retention cut.
    const lowerBounds = cap.blocksPreloadCalls.map(
      (h) =>
        (
          h.args.find(
            (a) => (a as unknown[])[0] === "ts" && (a as unknown[])[1] === ">",
          ) as unknown[]
        )[2] as number,
    );
    const oldestLo = Math.min(...lowerBounds);
    expect(oldestLo).toBeLessThanOrEqual(blocksRetentionCutoff());

    // Warm flag persisted with the client group id as value.
    expect(localStorage.getItem("friday.zero.blocksBackfillComplete")).toBe("test-cg");
  });

  // Stub fetch with a synchronous-`.json()` response so `#init` drains under
  // fake timers — a real `Response.json()` reads the body on a faked
  // macrotask and would hang the init await chain.
  function stubSyncFetch(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          token: "test-token-123",
          deviceId: "test-device-id",
          userId: "test-user-id",
          expiresAt: Date.now() + 900_000,
        }),
      })),
    );
  }

  it("starts via the 10s fallback when no foreground bind ever happens (FRI-161 AC 7b)", async () => {
    vi.useFakeTimers();
    stubSyncFetch();
    try {
      const cap = await patchZeroForBackfill();
      const { zeroSync } = await importStore();
      // Drain init's await chain (fetch → json → clientGroupID) so the
      // fallback timer is armed, without crossing 10s.
      await vi.advanceTimersByTimeAsync(100);
      expect(cap.blocksPreloadCalls.length).toBe(0);
      expect(zeroSync.blocksBackfill).toBe("idle");

      // Cross the 10s fallback (generous margin past the arm time).
      await vi.advanceTimersByTimeAsync(11_000);
      expect(zeroSync.blocksBackfill).toBe("running");
      expect(cap.blocksPreloadCalls.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("foreground 'complete' starts backfill once; the 10s fallback does NOT double-start it (FRI-161 AC 7a)", async () => {
    vi.useFakeTimers();
    stubSyncFetch();
    try {
      const cap = await patchZeroForBackfill();
      const { zeroSync } = await importStore();
      await vi.advanceTimersByTimeAsync(100);

      zeroSync.bindBlocksFor("friday");
      cap.fireForegroundComplete();
      await vi.advanceTimersByTimeAsync(0);
      expect(zeroSync.blocksBackfill).toBe("running");
      const afterTrigger = cap.blocksPreloadCalls.length;
      expect(afterTrigger).toBe(1);

      // Advancing past the 10s fallback must not arm a second backfill.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(cap.blocksPreloadCalls.length).toBe(afterTrigger);
      expect(zeroSync.blocksBackfill).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a foreground rebind is NOT blocked by an in-flight backfill chunk (FRI-161 AC 8)", async () => {
    const cap = await patchZeroForBackfill();
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));

    zeroSync.bindBlocksFor("friday");
    cap.fireForegroundComplete();
    await Promise.resolve();
    await Promise.resolve();
    // Chunk 1 in flight (unresolved).
    expect(cap.blocksPreloadCalls.length).toBe(1);

    const matBefore = cap.materialize().mock.calls.length;
    // Synchronous rebind to a different agent must materialize immediately.
    zeroSync.bindBlocksFor("alpha");
    expect(zeroSync.blocksAgent).toBe("alpha");
    expect(cap.materialize().mock.calls.length).toBe(matBefore + 1);
  });

  it("backfill completion widens the foreground window without an empty frame (FRI-161 AC 9)", async () => {
    const cap = await patchZeroForBackfill();
    const { zeroSync, blocksRetentionCutoff } = await importStore();
    await new Promise((r) => setTimeout(r, 30));

    let emptyFramesDuringSwap = 0;
    let armed = false;
    zeroSync.onBlocksUpdate((rows) => {
      if (armed && rows.length === 0) emptyFramesDuringSwap++;
    });

    zeroSync.bindBlocksFor("friday");
    expect(zeroSync.blocksFullWindow).toBe(false);
    expect(zeroSync.blocks.length).toBe(1);
    // The narrow foreground view is now materialized; record where in the
    // lifecycle log the swap begins so we can assert the swap's OWN ordering
    // (materialize-before-destroy) without it being masked by init-time
    // materializations.
    const lifecycleBeforeSwap = cap.viewLifecycle.length;
    armed = true;
    cap.fireForegroundComplete();

    // Drain all chunks.
    for (let guard = 0; guard < 200 && zeroSync.blocksBackfill === "running"; guard++) {
      await Promise.resolve();
      await Promise.resolve();
      const last = cap.blocksPreloadCalls[cap.blocksPreloadCalls.length - 1];
      if (last) last.resolve();
    }
    await Promise.resolve();
    expect(zeroSync.blocksBackfill).toBe("complete");
    expect(zeroSync.blocksFullWindow).toBe(true);
    expect(emptyFramesDuringSwap).toBe(0);

    // Load-bearing swap-ordering assertion. `unbindBlocks`'s `blocks = []`
    // write never notifies `#blocksListeners`, so the empty-frame counter
    // above cannot by itself catch a destroy-before-materialize regression in
    // `#widenForegroundWindow`. Pin the ordering directly: across the swap the
    // WIDER view must be materialized BEFORE the narrow view is destroyed.
    const swapEvents = cap.viewLifecycle.slice(lifecycleBeforeSwap);
    const firstMaterialize = swapEvents.find((e) => e.event === "materialize");
    const firstDestroy = swapEvents.find((e) => e.event === "destroy");
    expect(firstMaterialize, "the widen swap must materialize a new view").toBeDefined();
    expect(firstDestroy, "the widen swap must destroy the old narrow view").toBeDefined();
    // The new (wider) view materializes before the old (narrow) view is destroyed.
    expect(firstMaterialize!.seq).toBeLessThan(firstDestroy!.seq);

    // The widened foreground query was re-issued with the FULL retention bound.
    const tsBounds = cap
      .queryCalls()
      .filter(
        (c) =>
          c.method === "where" &&
          (c.args as unknown[])[0] === "ts" &&
          (c.args as unknown[])[1] === ">",
      )
      .map((c) => (c.args as unknown[])[2] as number);
    expect(tsBounds).toContain(blocksRetentionCutoff());
  });

  it("chunk literals are stable across two backfill runs in the same day (FRI-161 AC 11)", async () => {
    vi.useFakeTimers();
    stubSyncFetch();
    vi.setSystemTime(new Date("2026-06-09T14:00:00.000Z"));
    try {
      const collect = async (): Promise<number[][]> => {
        const cap = await patchZeroForBackfill();
        const { zeroSync } = await importStore();
        await vi.advanceTimersByTimeAsync(100);
        zeroSync.bindBlocksFor("friday");
        cap.fireForegroundComplete();
        for (let guard = 0; guard < 200 && zeroSync.blocksBackfill === "running"; guard++) {
          await vi.advanceTimersByTimeAsync(0);
          const last = cap.blocksPreloadCalls[cap.blocksPreloadCalls.length - 1];
          if (last) last.resolve();
        }
        await vi.advanceTimersByTimeAsync(0);
        return cap.blocksPreloadCalls.map((h) =>
          h.args
            .filter((a) => (a as unknown[])[0] === "ts")
            .map((a) => (a as unknown[])[2] as number),
        );
      };
      const run1 = await collect();
      vi.resetModules();
      instances.length = 0;
      const run2 = await collect();
      expect(run2).toEqual(run1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a chunk error retries once then parks as 'error' without writing the warm flag (FRI-161 AC 12)", async () => {
    const cap = await patchZeroForBackfill();
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));

    zeroSync.bindBlocksFor("friday");
    cap.fireForegroundComplete();
    await Promise.resolve();
    await Promise.resolve();
    // First attempt of chunk 1.
    expect(cap.blocksPreloadCalls.length).toBe(1);
    cap.blocksPreloadCalls[0].reject(new Error("boom-1"));
    await Promise.resolve();
    await Promise.resolve();
    // Retry: a second preload for the same (head) chunk.
    expect(cap.blocksPreloadCalls.length).toBe(2);
    cap.blocksPreloadCalls[1].reject(new Error("boom-2"));
    await Promise.resolve();
    await Promise.resolve();

    expect(zeroSync.blocksBackfill).toBe("error");
    // No further chunks issued after the retry exhausts.
    expect(cap.blocksPreloadCalls.length).toBe(2);
    // Warm flag must NOT be written on error.
    expect(localStorage.getItem("friday.zero.blocksBackfillComplete")).toBeNull();
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

  it("forgetDevice forwards the deviceId AND a fresh `ts` to zero.mutate.forgetDevice (plan §41 revoke-at semantics)", async () => {
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 40));
    expect(instances).toHaveLength(1);
    const z = instances[0];
    const before = Date.now();
    zeroSync.forgetDevice("dev-to-evict");
    expect(z.mutate.forgetDevice).toHaveBeenCalledTimes(1);
    const args = z.mutate.forgetDevice.mock.calls[0][0] as {
      deviceId: string;
      ts: number;
    };
    expect(args.deviceId).toBe("dev-to-evict");
    expect(args.ts).toBeGreaterThanOrEqual(before);
    expect(args.ts).toBeLessThanOrEqual(Date.now());
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

  it("forgetDevice surfaces server errors via console.warn", async () => {
    // FRI-104 AC #11: fire-and-forget mutators wrap the result through
    // awaitMutatorServer so failures surface in devtools instead of
    // being silently dropped. forgetDevice is a user-explicit action
    // (Settings → Devices → Forget) so the level is `warn`.
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 40));
    expect(instances).toHaveLength(1);
    const z = instances[0];
    z.mutate.forgetDevice = vi.fn(() => ({
      client: Promise.resolve({ type: "success" }),
      server: Promise.resolve({
        type: "error",
        error: {
          type: "app",
          message: "already-revoked",
          details: undefined,
        },
      }),
    }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    zeroSync.forgetDevice("dev");
    // Drain microtasks: the wrapper kicks off an async `.then(...)` on
    // the resolved server promise; two yields cover both await steps
    // inside `awaitMutatorServer` plus the `.then` callback.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalledWith("forgetDevice mutator error: already-revoked");
    warnSpy.mockRestore();
  });

  it("updateSettings surfaces server errors via console.warn", async () => {
    // FRI-104 AC #11: mirror the forgetDevice test for updateSettings —
    // also user-explicit, also warn-level. The unconditional "saved"
    // toast in settings/+page.svelte is OUT OF SCOPE; this test only
    // pins the wrapper-level log surface.
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 40));
    expect(instances).toHaveLength(1);
    const z = instances[0];
    z.mutate.updateSettings = vi.fn(() => ({
      client: Promise.resolve({ type: "success" }),
      server: Promise.resolve({
        type: "error",
        error: {
          type: "app",
          message: "invalid model",
          details: undefined,
        },
      }),
    }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    zeroSync.updateSettings({ model: "claude-bogus" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalledWith("updateSettings mutator error: invalid model");
    warnSpy.mockRestore();
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
    expect(() => zeroSync.updateSettings({ model: "claude-opus-4-7" })).not.toThrow();
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
      expect(z.mutate.reportClientStats.mock.calls.length).toBe(callsBeforeDestroy);
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
    expect(() => zeroSync.createTicket({ id: "FRI-1", title: "x" })).not.toThrow();
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
    expect(() => zeroSync.createSchedule({ name: "x", taskPrompt: "X" })).not.toThrow();
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
    expect(() => zeroSync.installApp({ id: "x", folderPath: "/x" })).not.toThrow();
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

  it("uses the caller-supplied blockId + derives t_-prefixed turn_id and dispatches the mutator with the full args", async () => {
    // FRI-103: blockId is now pre-minted by sendQueue at enqueue time
    // and threaded through so retries reuse the same canonical id.
    const { zeroSync, z } = await bootedZero();
    const blockId = "70df2671-7d96-45c7-83bf-28bfd0317f2a";
    const out = await zeroSync.sendUserMessage({
      blockId,
      agent: "friday",
      text: "hello agent",
    });
    // FRI-139: discriminated outcome shape.
    expect(out).toEqual({ kind: "ok", blockId, turnId: `t_${blockId}` });

    expect(z.mutate.sendUserMessage).toHaveBeenCalledTimes(1);
    const args = z.mutate.sendUserMessage.mock.calls[0][0] as {
      id: string;
      turnId: string;
      agentName: string;
      text: string;
      attachments?: unknown;
      ts: number;
    };
    expect(args.id).toBe(blockId);
    expect(args.turnId).toBe(`t_${blockId}`);
    expect(args.agentName).toBe("friday");
    expect(args.text).toBe("hello agent");
    expect(typeof args.ts).toBe("number");
    expect(args.attachments).toBeUndefined();
  });

  it("forwards attachments verbatim to the mutator", async () => {
    const { zeroSync, z } = await bootedZero();
    const attachments = [{ sha256: "a".repeat(64), filename: "shot.png", mime: "image/png" }];
    await zeroSync.sendUserMessage({
      blockId: "11111111-2222-3333-4444-555555555555",
      agent: "friday",
      text: "see this",
      attachments,
    });
    const args = z.mutate.sendUserMessage.mock.calls[0][0] as {
      attachments?: Array<{ sha256: string }>;
    };
    expect(args.attachments).toEqual(attachments);
  });

  it("sendUserMessage returns {kind:'ok',blockId,turnId} when server resolves to {type:'error', error:{type:'app'}} that matches a blocks_pkey PK collision (idempotent retry)", async () => {
    // FRI-104: the dashboard treats a PK violation on `blocks.id` as a
    // dedup success — the original push committed, this retry is
    // idempotent (FRI-103 invariant). FRI-139: returns the `ok` variant
    // so callers route through the confirmPending happy path.
    const { zeroSync, z } = await bootedZero();
    z.mutate.sendUserMessage = vi.fn(() => ({
      client: Promise.resolve({ type: "success" }),
      server: Promise.resolve({
        type: "error",
        error: {
          type: "app",
          message: 'duplicate key value violates unique constraint "blocks_pkey"',
          details: { name: "PostgresError" },
        },
      }),
    }));
    const out = await zeroSync.sendUserMessage({
      blockId: "22222222-3333-4444-5555-666666666666",
      agent: "friday",
      text: "boom",
    });
    expect(out).toEqual({
      kind: "ok",
      blockId: "22222222-3333-4444-5555-666666666666",
      turnId: "t_22222222-3333-4444-5555-666666666666",
    });
  });

  it("sendUserMessage returns {kind:'app-error',message} when server resolves to {type:'error', error:{type:'app'}} that is NOT a PK collision (real failure)", async () => {
    // FRI-104: a genuine app-error must NOT be treated as success.
    // FRI-139: the wrapper now surfaces the app-error message so the
    // caller can immediately flip the optimistic to FAILED-TO-SEND
    // (the DB row does not exist; nothing to wait for).
    const { zeroSync, z } = await bootedZero();
    z.mutate.sendUserMessage = vi.fn(() => ({
      client: Promise.resolve({ type: "success" }),
      server: Promise.resolve({
        type: "error",
        error: {
          type: "app",
          message: "agent not found",
          details: undefined,
        },
      }),
    }));
    const out = await zeroSync.sendUserMessage({
      blockId: "44444444-5555-6666-7777-888888888888",
      agent: "ghost",
      text: "lost",
    });
    expect(out).toEqual({ kind: "app-error", message: "agent not found" });
  });

  it("sendUserMessage returns {kind:'transport-error',message} when server resolves to {type:'error', error:{type:'zero'}} (transport — Zero outbox will re-push)", async () => {
    // FRI-104: transport-level `zero-error` is transient — Zero's
    // persistent outbox has already enqueued the mutation and will
    // re-push when the connection comes back.
    // FRI-139: the wrapper now surfaces the transport-error variant
    // separately from app-error so callers can distinguish "server
    // rejected the write" (mark failed) from "WS hiccup" (keep the
    // optimistic in pending; arm the long-window fallback).
    const { zeroSync, z } = await bootedZero();
    z.mutate.sendUserMessage = vi.fn(() => ({
      client: Promise.resolve({ type: "success" }),
      server: Promise.resolve({
        type: "error",
        error: { type: "zero", message: "Offline" },
      }),
    }));
    const out = await zeroSync.sendUserMessage({
      blockId: "55555555-6666-7777-8888-999999999999",
      agent: "friday",
      text: "transient",
    });
    expect(out).toEqual({ kind: "transport-error", message: "Offline" });
  });

  it("returns {kind:'no-zero'} before Zero has finished initializing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { zeroSync } = await importStore();
    await expect(
      zeroSync.sendUserMessage({
        blockId: "33333333-4444-5555-6666-777777777777",
        agent: "friday",
        text: "x",
      }),
    ).resolves.toEqual({ kind: "no-zero" });
  });
});

describe("FRI-139 review-2: cancelByBlockIdOnDiscard wrapper", () => {
  // The DISCARD path's underlying-mutation cleanup. Used when
  // discardPending fires for a queueId whose `/api/mutators` push may
  // have committed (transport-error case). Two legs:
  //   - daemon fast-path POST /api/internal/cancel-queued (idempotent
  //     — daemon returns already_canceled if the LISTEN-path raced it).
  //   - cancelQueued Zero mutator dispatch IF the row is in the local
  //     snapshot (durable cross-device).
  async function bootedZero() {
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    return { zeroSync, z: instances[0]! };
  }

  function seedRow(zeroSync: {
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
        id: "fri139-discard-block-id",
        block_id: "fri139-discard-block-id",
        turn_id: "t_fri139-discard-block-id",
        agent_name: "friday",
        role: "user",
        source: "user_chat",
        status: "queued",
        content_json: { text: "ghost mutation" },
      },
    ];
  }

  it("POSTs the daemon fast-path with the block_id (always — independent of local snapshot state)", async () => {
    const { zeroSync } = await bootedZero();
    const spy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, already_canceled: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", spy);
    // No row seeded — fast-path still fires unconditionally.
    await zeroSync.cancelByBlockIdOnDiscard("fri139-discard-block-id");
    const first = spy.mock.calls[0];
    expect(first?.[0]).toBe("/api/internal/cancel-queued");
    const init = first?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      block_id: "fri139-discard-block-id",
    });
  });

  it("ALSO dispatches the cancelQueued mutator when the row is in the local Zero snapshot (durable cross-device)", async () => {
    const { zeroSync, z } = await bootedZero();
    seedRow(zeroSync as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await zeroSync.cancelByBlockIdOnDiscard("fri139-discard-block-id");
    expect(z.mutate.cancelQueued).toHaveBeenCalledTimes(1);
    const args = z.mutate.cancelQueued.mock.calls[0][0] as {
      id: string;
      ts: number;
    };
    expect(args.id).toBe("fri139-discard-block-id");
    expect(typeof args.ts).toBe("number");
  });

  it("does NOT dispatch the cancelQueued mutator when the row is absent from the local snapshot (transport-error has not replicated yet)", async () => {
    // The transport-error path's whole point: the row may not have
    // landed in the local replica when the user discards. Daemon
    // fast-path POST is the only cancel leg in this case; the mutator
    // skip is the correct behavior, not a regression.
    const { zeroSync, z } = await bootedZero();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await zeroSync.cancelByBlockIdOnDiscard("no-row-yet");
    expect(z.mutate.cancelQueued).not.toHaveBeenCalled();
  });

  it("still dispatches the mutator when the daemon fast-path fetch throws (network down)", async () => {
    // Daemon-down resilience: the durable Zero-mutator path is the
    // backstop; the daemon's LISTEN handler picks up the
    // `cancel_requested` row on next reconnect.
    const { zeroSync, z } = await bootedZero();
    seedRow(zeroSync as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await zeroSync.cancelByBlockIdOnDiscard("fri139-discard-block-id");
    expect(z.mutate.cancelQueued).toHaveBeenCalledTimes(1);
  });

  it("is silent before Zero has finished initialising", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { zeroSync } = await importStore();
    // Returns void; assert it doesn't throw and doesn't dispatch.
    await zeroSync.cancelByBlockIdOnDiscard("any-id");
  });
});

describe("FRI-121 A1: connection.state → status transitions", () => {
  async function bootedZero() {
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    return { zeroSync, z: instances[0]! };
  }

  it("initializes to 'live' because the mock emits {name:'connected'} immediately on subscribe", async () => {
    const { zeroSync } = await bootedZero();
    expect(zeroSync.status).toBe("live");
    expect(zeroSync.errorMessage).toBeNull();
  });

  it("transitions to 'error' with errorMessage when reason is a string", async () => {
    const { zeroSync, z } = await bootedZero();
    z.__emitConnState({ name: "error", reason: "jwt expired" });
    expect(zeroSync.status).toBe("error");
    expect(zeroSync.errorMessage).toBe("jwt expired");
  });

  it("transitions to 'error' with null errorMessage when reason is absent", async () => {
    const { zeroSync, z } = await bootedZero();
    z.__emitConnState({ name: "error" });
    expect(zeroSync.status).toBe("error");
    expect(zeroSync.errorMessage).toBeNull();
  });

  it("transitions to 'error' on {name:'closed'}", async () => {
    const { zeroSync, z } = await bootedZero();
    z.__emitConnState({ name: "closed" });
    expect(zeroSync.status).toBe("error");
  });

  it("transitions to 'error' on {name:'needs-auth'}", async () => {
    const { zeroSync, z } = await bootedZero();
    z.__emitConnState({ name: "needs-auth" });
    expect(zeroSync.status).toBe("error");
  });

  it("transitions to 'pending' on {name:'connecting'}", async () => {
    const { zeroSync, z } = await bootedZero();
    z.__emitConnState({ name: "connecting" });
    expect(zeroSync.status).toBe("pending");
  });

  it("transitions to 'pending' on {name:'disconnected'}", async () => {
    const { zeroSync, z } = await bootedZero();
    z.__emitConnState({ name: "disconnected" });
    expect(zeroSync.status).toBe("pending");
  });

  it("clears errorMessage when connection recovers to 'connected'", async () => {
    const { zeroSync, z } = await bootedZero();
    z.__emitConnState({ name: "error", reason: "timeout" });
    expect(zeroSync.errorMessage).toBe("timeout");
    z.__emitConnState({ name: "connected" });
    expect(zeroSync.status).toBe("live");
    expect(zeroSync.errorMessage).toBeNull();
  });
});

describe("FRI-121 A2: visibilitychange → terminal-state reconnect", () => {
  // Each test must destroy the store after use so the visibilitychange
  // listener is removed from document — otherwise handlers from prior
  // tests accumulate and fire when the destroy test dispatches the event.
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const td of teardowns) td();
    teardowns.length = 0;
  });

  async function bootedZero() {
    const { zeroSync } = await importStore();
    await new Promise((r) => setTimeout(r, 30));
    teardowns.push(() => zeroSync.destroy());
    return { zeroSync, z: instances[0]! };
  }

  it("fetches /api/sync/refresh and calls connection.connect({auth}) when tab becomes visible", async () => {
    const { z } = await bootedZero();

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });

    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchSpy.mockClear();
    z.connection.connect.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 30));

    const refreshCall = fetchSpy.mock.calls.find((c) => c[0] === "/api/sync/refresh");
    expect(refreshCall).toBeDefined();
    expect(z.connection.connect).toHaveBeenCalledTimes(1);
    expect(z.connection.connect.mock.calls[0][0]).toEqual({ auth: "test-token-123" });
  });

  it("does NOT call connection.connect when the tab goes hidden", async () => {
    const { z } = await bootedZero();

    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      writable: true,
      configurable: true,
    });

    z.connection.connect.mockClear();
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 30));

    expect(z.connection.connect).not.toHaveBeenCalled();
  });

  it("does not call connection.connect after destroy() tears down the listener", async () => {
    const { zeroSync, z } = await bootedZero();
    // Pop the auto-teardown so we control the destroy call ourselves.
    teardowns.length = 0;

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });

    zeroSync.destroy();

    // Check THIS instance's connect mock — instance-specific, unaffected by
    // other tests' stores that may still have listeners on document.
    z.connection.connect.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 30));

    // Either the listener was removed by destroy() or this.#zero was nulled
    // out — either way, no reconnect is attempted on this store's connection.
    expect(z.connection.connect).not.toHaveBeenCalled();
  });
});

describe("FRI-121 A3: 5-second watchdog nudges connect() after a recent send", () => {
  it("calls connect() when status !== 'live' and a message was sent within the last 30 s", async () => {
    vi.useFakeTimers();
    try {
      const { zeroSync } = await importStore();
      await vi.runAllTimersAsync().catch(() => {});
      expect(instances).toHaveLength(1);
      const z = instances[0]!;

      z.__emitConnState({ name: "error" });
      expect(zeroSync.status).toBe("error");

      await zeroSync.sendUserMessage({
        blockId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001",
        agent: "friday",
        text: "watchdog trigger",
      });

      z.connection.connect.mockClear();
      vi.advanceTimersByTime(5_000);

      // Watchdog fires connect() without args (terminal-state nudge only;
      // auth refresh is the visibilitychange handler's job).
      expect(z.connection.connect).toHaveBeenCalledTimes(1);
      expect(z.connection.connect.mock.calls[0]).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT call connect() when status is 'live'", async () => {
    vi.useFakeTimers();
    try {
      const { zeroSync } = await importStore();
      await vi.runAllTimersAsync().catch(() => {});
      expect(instances).toHaveLength(1);
      const z = instances[0]!;

      // Mock fires 'connected' on subscribe → status stays 'live'.
      expect(zeroSync.status).toBe("live");

      await zeroSync.sendUserMessage({
        blockId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0002",
        agent: "friday",
        text: "should not trigger watchdog",
      });

      z.connection.connect.mockClear();
      vi.advanceTimersByTime(5_000);

      expect(z.connection.connect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT call connect() when no message was sent recently (#lastSendAt=0)", async () => {
    vi.useFakeTimers();
    try {
      const { zeroSync } = await importStore();
      await vi.runAllTimersAsync().catch(() => {});
      expect(instances).toHaveLength(1);
      const z = instances[0]!;

      z.__emitConnState({ name: "error" });
      // #lastSendAt stays at 0 (class field default).
      // Date.now() under fake timers ≈ real system time >> 30_000 ms from epoch.
      z.connection.connect.mockClear();
      vi.advanceTimersByTime(5_000);

      expect(z.connection.connect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops firing after destroy() clears the watchdog interval", async () => {
    vi.useFakeTimers();
    try {
      const { zeroSync } = await importStore();
      await vi.runAllTimersAsync().catch(() => {});
      expect(instances).toHaveLength(1);
      const z = instances[0]!;

      z.__emitConnState({ name: "error" });
      await zeroSync.sendUserMessage({
        blockId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0003",
        agent: "friday",
        text: "before destroy",
      });

      zeroSync.destroy();
      z.connection.connect.mockClear();
      vi.advanceTimersByTime(5_000);

      expect(z.connection.connect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("JWT self-heal: proactive refresh + reactive re-auth", () => {
  // Falsification proof: zero-cache disconnects the WS with `needs-auth`
  // when the JWT's `exp` passes. Before this suite landed, the connection
  // subscriber only mapped that to status='error' and stopped — leaving
  // the widget red until the user reloaded. These tests pin the heal:
  //   1. Proactive timer re-mints ~60s before exp so the WS never trips
  //      under steady-state operation.
  //   2. Reactive recovery re-mints + reconnects on `needs-auth` with
  //      bounded exponential backoff, so the WS heals from clock skew /
  //      sleep-wake-past-expiry / bfcache without user action.
  //
  // Note: these tests use `vi.advanceTimersByTimeAsync` rather than
  // `vi.runAllTimersAsync()`. The proactive rotation reschedules itself
  // on success (recursive setTimeout), which is correct production
  // behavior but trips `runAllTimers`' nested-timer flush into an
  // unbounded loop. Precise-window advance avoids that.

  function refreshCalls(fetchSpy: ReturnType<typeof vi.fn>): readonly unknown[][] {
    return fetchSpy.mock.calls.filter((c) => c[0] === "/api/sync/refresh");
  }

  it("schedules a proactive refresh 60s before expiresAt and calls connect({auth}) with the fresh token", async () => {
    vi.useFakeTimers();
    try {
      const { zeroSync } = await importStore();
      // Boot init: fetch resolves, Zero ctor runs, schedulers arm.
      await vi.advanceTimersByTimeAsync(100);
      expect(instances.length).toBeGreaterThan(0);
      const z = instances[instances.length - 1]!;

      const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
      fetchSpy.mockClear();
      z.connection.connect.mockClear();

      // Mock fetch returns expiresAt = Date.now() + 900_000 (15 min).
      // The proactive timer should fire at 15min - 60s = 14min.
      // Advance to 1ms before the boundary first — no fire expected.
      await vi.advanceTimersByTimeAsync(14 * 60_000 - 200);
      expect(refreshCalls(fetchSpy)).toHaveLength(0);
      // Cross the boundary; the rotation fires + reschedules.
      await vi.advanceTimersByTimeAsync(300);

      expect(refreshCalls(fetchSpy)).toHaveLength(1);
      expect(z.connection.connect).toHaveBeenCalledTimes(1);
      expect(z.connection.connect.mock.calls[0][0]).toEqual({ auth: "test-token-123" });
      zeroSync.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-mints + reconnects on `needs-auth` (the actual bug Seth caught)", async () => {
    vi.useFakeTimers();
    try {
      const { zeroSync } = await importStore();
      await vi.advanceTimersByTimeAsync(100);
      const z = instances[instances.length - 1]!;

      const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
      fetchSpy.mockClear();
      z.connection.connect.mockClear();

      // Simulate the JWT expiring mid-session — zero-cache rejects the WS.
      z.__emitConnState({ name: "needs-auth" });
      expect(zeroSync.status).toBe("error");
      // Reactive timer fires after 500ms (attempt 0). Before that, no
      // refresh call yet.
      await vi.advanceTimersByTimeAsync(499);
      expect(refreshCalls(fetchSpy)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2);

      expect(refreshCalls(fetchSpy)).toHaveLength(1);
      expect(z.connection.connect).toHaveBeenCalledTimes(1);
      expect(z.connection.connect.mock.calls[0][0]).toEqual({ auth: "test-token-123" });

      // When the rotation succeeds and zero-cache transitions to
      // 'connected', the reactive backoff counter resets so the next
      // expiry isn't penalized.
      z.__emitConnState({ name: "connected" });
      expect(zeroSync.status).toBe("live");

      zeroSync.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off exponentially when refresh keeps failing on `needs-auth` (500ms → 1s → 2s)", async () => {
    vi.useFakeTimers();
    try {
      const { zeroSync } = await importStore();
      await vi.advanceTimersByTimeAsync(100);
      const z = instances[instances.length - 1]!;

      // Refresh endpoint always 500s — BetterAuth session dead.
      const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
      fetchSpy.mockImplementation((url: string) =>
        Promise.resolve(
          url === "/api/sync/refresh"
            ? new Response("server error", { status: 500 })
            : new Response("", { status: 200 }),
        ),
      );
      fetchSpy.mockClear();
      z.connection.connect.mockClear();

      // Three failed needs-auth cycles. Test re-emits after each window
      // to simulate zero-cache's own retry tick re-asserting needs-auth.
      const expectedDelays = [500, 1000, 2000];
      for (const [i, delay] of expectedDelays.entries()) {
        z.__emitConnState({ name: "needs-auth" });
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(refreshCalls(fetchSpy)).toHaveLength(i);
        await vi.advanceTimersByTimeAsync(2);
        expect(refreshCalls(fetchSpy)).toHaveLength(i + 1);
        // connect() never called because rotation failed.
        expect(z.connection.connect).not.toHaveBeenCalled();
      }
      zeroSync.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops scheduling reactive retries after MAX_REACTIVE_ATTEMPTS (6)", async () => {
    vi.useFakeTimers();
    try {
      const { zeroSync } = await importStore();
      await vi.advanceTimersByTimeAsync(100);
      const z = instances[instances.length - 1]!;

      const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
      fetchSpy.mockImplementation(() =>
        Promise.resolve(new Response("server error", { status: 500 })),
      );
      fetchSpy.mockClear();

      // Six attempts at delays 500, 1000, 2000, 4000, 8000, 16000.
      const delays = [500, 1000, 2000, 4000, 8000, 16000];
      for (const [i, delay] of delays.entries()) {
        z.__emitConnState({ name: "needs-auth" });
        await vi.advanceTimersByTimeAsync(delay + 1);
        expect(refreshCalls(fetchSpy)).toHaveLength(i + 1);
      }

      // The 7th needs-auth must not schedule a new attempt — counter capped.
      z.__emitConnState({ name: "needs-auth" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refreshCalls(fetchSpy)).toHaveLength(6);
      zeroSync.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels both timers on destroy() so no rotations fire after teardown", async () => {
    vi.useFakeTimers();
    try {
      const { zeroSync } = await importStore();
      await vi.advanceTimersByTimeAsync(100);
      const z = instances[instances.length - 1]!;

      // Arm reactive timer, then destroy before it fires.
      z.__emitConnState({ name: "needs-auth" });
      const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
      fetchSpy.mockClear();
      zeroSync.destroy();

      await vi.advanceTimersByTimeAsync(60 * 60_000); // 1 hour
      expect(refreshCalls(fetchSpy)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
