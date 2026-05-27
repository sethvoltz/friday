/**
 * @vitest-environment node
 *
 * Reconnect-loop unit tests for the archive LISTEN handler (FRI-121 AC8/AC9).
 *
 * The reconnect pattern — keepAlive pg.Client, exponential backoff on error,
 * boot-scan after each (re)connect — is shared by all eight daemon LISTEN
 * handlers. We pin the behaviour here against the archive listener (the
 * simplest non-trivial case) using a FakeClient driven by Node EventEmitter
 * to avoid a real Postgres connection.
 *
 * AC8: each Client is created with { keepAlive: true }; the loop reconnects
 *      automatically after the connection drops.
 * AC9: runArchiveBootScan() is called once per successful LISTEN, including
 *      on reconnects — so NOTIFYs missed during downtime are drained.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fake pg.Client — controllable via Node EventEmitter.
// ---------------------------------------------------------------------------

const clientInstances: FakeClient[] = [];

class FakeClient extends EventEmitter {
  opts: Record<string, unknown>;
  connect = vi.fn(async () => {});
  query = vi.fn(async (_sql: string) => ({ rows: [] }));
  end = vi.fn(async () => {
    this.emit("end");
  });

  constructor(opts: Record<string, unknown>) {
    super();
    this.opts = opts;
    clientInstances.push(this);
  }
}

vi.mock("pg", () => ({
  default: { Client: FakeClient },
}));

// ---------------------------------------------------------------------------
// Mock @friday/shared — minimal chain that resolves empty rows.
// The DB chain must be thenable (await db.select().from().where() → []) and
// also support .limit() for the per-row process function.
// ---------------------------------------------------------------------------

function makeDbChain(rows: unknown[] = []): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(rows)),
    update: vi.fn(() => chain),
    set: vi.fn(() => chain),
    // Make the chain thenable so `await db.select().from().where()` works.
    then: (resolve: (v: unknown) => void, _reject?: unknown) => resolve(rows),
  };
  return chain;
}

const mockSelectSpy = vi.fn(() => makeDbChain());
const mockDb = { select: mockSelectSpy, update: vi.fn(() => makeDbChain()) };

vi.mock("@friday/shared", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  getDb: vi.fn(() => mockDb),
  getPool: vi.fn(() => ({
    options: { connectionString: "postgresql://localhost/friday_test" },
  })),
  schema: {
    agents: { name: {}, status: {}, archiveReason: {} },
  },
  LISTEN_CHANNELS: {
    archiveRequested: "friday_archive_requested",
  },
}));

vi.mock("./lifecycle.js", () => ({
  archiveAgent: vi.fn(async () => {}),
  // Other lifecycle exports referenced by sibling modules — no-op them.
  dispatchTurn: vi.fn(),
  abortTurn: vi.fn(() => false),
  removeQueuedPrompt: vi.fn(() => null),
  peekLiveWorker: vi.fn(() => null),
}));

vi.mock("../log.js", () => ({
  logger: { log: vi.fn() },
}));

// drizzle-orm's eq/and are pure helpers whose return values are passed to the
// mock chain's where(); our chain ignores the argument, so these just need to
// return *something* without side-effects.
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function importListener() {
  return await import("./archive-listener.js");
}

beforeEach(() => {
  clientInstances.length = 0;
  vi.clearAllMocks();
  mockSelectSpy.mockImplementation(() => makeDbChain());
  mockDb.update.mockImplementation(() => makeDbChain());
});

afterEach(() => {
  vi.resetModules(); // fresh module closure (stopped/activeClient) per test
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FRI-121 B: archive-listener reconnect loop (AC8/AC9)", () => {
  it("passes keepAlive: true to the pg.Client constructor (AC8)", async () => {
    const { startArchiveListener } = await importListener();
    const handle = await startArchiveListener();

    // Give the background connectWithRetry() one event-loop turn to land.
    await new Promise((r) => setTimeout(r, 20));

    expect(clientInstances.length).toBeGreaterThanOrEqual(1);
    expect(clientInstances[0]!.opts.keepAlive).toBe(true);

    await handle.stop();
  });

  it("runs runArchiveBootScan (db.select) after the first LISTEN (AC9)", async () => {
    const { startArchiveListener } = await importListener();
    const handle = await startArchiveListener();

    await new Promise((r) => setTimeout(r, 20));

    // runArchiveBootScan calls db.select() once for the pending-row query.
    expect(mockSelectSpy).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it("creates a second Client and runs boot-scan again after the first connection ends (AC8/AC9)", async () => {
    const { startArchiveListener } = await importListener();
    const handle = await startArchiveListener();

    // Wait for the first client to connect and reach the 'end' await.
    await new Promise((r) => setTimeout(r, 20));
    expect(clientInstances).toHaveLength(1);
    const firstClient = clientInstances[0]!;
    expect(mockSelectSpy).toHaveBeenCalledTimes(1);

    // Simulate the connection dropping — emitting "end" resolves the
    // `c.once("end", resolve)` promise in the reconnect loop, causing
    // the loop to iterate and create a new Client.
    firstClient.emit("end");

    // Give the loop time to construct the second client and run the boot scan.
    await new Promise((r) => setTimeout(r, 20));

    expect(clientInstances).toHaveLength(2);
    expect(clientInstances[1]!.opts.keepAlive).toBe(true);
    // Boot scan fires on each successful LISTEN — now called twice total.
    expect(mockSelectSpy).toHaveBeenCalledTimes(2);

    await handle.stop();
  });

  it("stop() halts the loop so no third Client is created after the second ends", async () => {
    const { startArchiveListener } = await importListener();
    const handle = await startArchiveListener();

    await new Promise((r) => setTimeout(r, 20));
    expect(clientInstances).toHaveLength(1);

    // Stop, then emit "end" — the loop must not create another client.
    await handle.stop();
    clientInstances[0]!.emit("end");

    await new Promise((r) => setTimeout(r, 20));
    // Still only one client (or the one created by stop's UNLISTEN+end).
    // The reconnect loop should have exited because stopped===true.
    const countAfter = clientInstances.length;
    expect(countAfter).toBeLessThanOrEqual(2); // stop() may create its own end event
    // Crucially: select is still called only once (no extra boot scan).
    expect(mockSelectSpy).toHaveBeenCalledTimes(1);
  });
});
