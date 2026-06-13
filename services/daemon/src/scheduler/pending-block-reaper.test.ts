/**
 * Pending-block reaper — SEV-0 "no user message is ever lost" backstop.
 *
 * Two layers, each tested where its bug would live (mirrors
 * compaction-sweep.test.ts):
 *
 *   - `selectStalePending` — the pure age-gate policy: rows older than the
 *     stale threshold are selected, fresh/in-flight rows are left alone.
 *     Injected `now`, no fake timers (repo convention).
 *
 *   - `__tickForTest` — the imperative pass against a real scratch Postgres
 *     (createTestDb) with seeded `blocks` rows + a SPY on the shared
 *     `processPendingBlockRow` dispatch entrypoint. Proves:
 *       (a) a stale user_chat pending block is re-dispatched through that
 *           SAME entrypoint;
 *       (b) a fresh (within-threshold) block is left alone;
 *       (c) no double-dispatch when the row was already claimed (status flipped
 *           off 'pending' before the pass) — the spy is the real function,
 *           which re-reads + short-circuits;
 *       (d) a non-user_chat user `pending` row is surfaced as an
 *           invariant-violation WARN and left UNTOUCHED (no destructive flip,
 *           no synthetic error block — a flip on source alone could clobber a
 *           legit future in-flight queued non-user_chat block);
 *       (e) a stale `queued` user row is ignored (queued dropped from
 *           SCAN_STATUSES — scanning it was a noisy no-op).
 *
 * The authoritative two-caller claim-race test (two REAL
 * `processPendingBlockRow` calls that both pass the pending read → exactly one
 * dispatch) lives in agent/dispatch-listener.test.ts where that function and
 * its rowCount claim guard live.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";
import { and, eq } from "drizzle-orm";

import {
  selectStalePending,
  __tickForTest,
  __resetForTest,
  type PendingBlockRow,
} from "./pending-block-reaper.js";

const STALE_THRESHOLD_MS = 45_000;
const NOW = new Date("2026-06-13T12:00:00.000Z").getTime();

function row(overrides: Partial<PendingBlockRow> = {}): PendingBlockRow {
  return {
    id: "id-1",
    blockId: "blk-1",
    turnId: "t_1",
    agentName: "friday",
    sessionId: "__pending__",
    role: "user",
    source: "user_chat",
    ts: NOW - STALE_THRESHOLD_MS - 1, // stale by default
    ...overrides,
  };
}

describe("selectStalePending (pure age gate)", () => {
  it("selects a row older than the stale threshold", () => {
    const r = row({ ts: NOW - STALE_THRESHOLD_MS - 1 });
    expect(selectStalePending([r], NOW)).toEqual([r]);
  });

  it("leaves a fresh row (younger than the threshold) alone", () => {
    const r = row({ ts: NOW - 1_000 });
    expect(selectStalePending([r], NOW)).toEqual([]);
  });

  it("selects a row exactly AT the threshold boundary (<= cutoff)", () => {
    const r = row({ ts: NOW - STALE_THRESHOLD_MS });
    expect(selectStalePending([r], NOW)).toEqual([r]);
  });

  it("partitions a mixed batch: stale selected, fresh excluded", () => {
    const stale = row({ id: "old", blockId: "old", ts: NOW - STALE_THRESHOLD_MS - 5_000 });
    const fresh = row({ id: "new", blockId: "new", ts: NOW - 2_000 });
    expect(selectStalePending([stale, fresh], NOW)).toEqual([stale]);
  });
});

/* ----------------------- imperative tick (integration) ----------------------- */

let handle: TestDbHandle;
let dispatchListener: typeof import("../agent/dispatch-listener.js");
let log: typeof import("../log.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "pending_block_reaper" });
  dispatchListener = await import("../agent/dispatch-listener.js");
  log = await import("../log.js");
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  __resetForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function insertBlockRow(opts: {
  id: string;
  status: string;
  tsMs: number;
  role?: string;
  source?: string | null;
}): Promise<void> {
  const db = getDb();
  await db.insert(schema.blocks).values({
    id: opts.id,
    blockId: opts.id,
    turnId: `t_${opts.id}`,
    agentName: "friday",
    sessionId: "__pending__",
    messageId: null,
    blockIndex: 0,
    role: opts.role ?? "user",
    kind: "text",
    source: opts.source === undefined ? "user_chat" : opts.source,
    contentJson: { text: "hello" },
    status: opts.status,
    streaming: false,
    originMutationId: null,
    ts: new Date(opts.tsMs),
  });
}

async function statusOf(id: string): Promise<string | undefined> {
  const db = getDb();
  const rows = await db
    .select({ status: schema.blocks.status })
    .from(schema.blocks)
    .where(eq(schema.blocks.id, id))
    .limit(1);
  return rows[0]?.status;
}

describe("__tickForTest (imperative pass against scratch Postgres)", () => {
  it("(a) re-dispatches a stale user_chat pending block through processPendingBlockRow", async () => {
    await insertBlockRow({ id: "stale", status: "pending", tsMs: NOW - STALE_THRESHOLD_MS - 1_000 });

    // Spy the shared dispatch entrypoint so we don't fork a real worker — the
    // point is that the reaper FUNNELS through this exact function.
    const spy = vi
      .spyOn(dispatchListener, "processPendingBlockRow")
      .mockImplementation(async () => {});

    await __tickForTest(NOW);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("stale");
  });

  it("(b) leaves a fresh (within-threshold) pending block alone", async () => {
    await insertBlockRow({ id: "fresh", status: "pending", tsMs: NOW - 2_000 });

    const spy = vi
      .spyOn(dispatchListener, "processPendingBlockRow")
      .mockImplementation(async () => {});

    await __tickForTest(NOW);

    expect(spy).not.toHaveBeenCalled();
    // Untouched — still pending for the normal NOTIFY path / next pass.
    expect(await statusOf("fresh")).toBe("pending");
  });

  it("(c) no double-dispatch: a row already claimed (flipped off pending) is a no-op via the re-read", async () => {
    // The row is old enough to be SELECTED by the reaper's SQL scan only if it
    // still matches the status filter. Simulate the normal NOTIFY path having
    // already claimed it: status is 'complete'. The scan's status filter
    // excludes it, so the spy never fires — proving the reaper can't
    // double-dispatch a row the live path won.
    await insertBlockRow({
      id: "claimed",
      status: "complete",
      tsMs: NOW - STALE_THRESHOLD_MS - 1_000,
    });

    const spy = vi
      .spyOn(dispatchListener, "processPendingBlockRow")
      .mockImplementation(async () => {});

    await __tickForTest(NOW);

    expect(spy).not.toHaveBeenCalled();
  });

  it("(c') TOCTOU: a row claimed BETWEEN select and dispatch is not double-dispatched (real re-read)", async () => {
    // The row is still 'pending' at the reaper's SELECT (so it IS picked up).
    // We then simulate the live NOTIFY path claiming it in the gap before
    // dispatch by flipping it to 'complete', and invoke the REAL
    // `processPendingBlockRow`: it re-reads by id, sees status !== 'pending',
    // and short-circuits — so no second dispatch occurs.
    await insertBlockRow({
      id: "toctou",
      status: "pending",
      tsMs: NOW - STALE_THRESHOLD_MS - 1_000,
    });
    const db = getDb();

    let dispatchedTurn = false;
    // Wrap: simulate the normal path claiming the row in the gap, then call the
    // REAL processPendingBlockRow which must short-circuit on the re-read.
    const real = dispatchListener.processPendingBlockRow;
    vi.spyOn(dispatchListener, "processPendingBlockRow").mockImplementation(async (id: string) => {
      // The live NOTIFY path won the race: flip off 'pending' first.
      await db
        .update(schema.blocks)
        .set({ status: "complete" })
        .where(eq(schema.blocks.id, "toctou"));
      // Now the reaper's dispatch runs the REAL function: it re-reads and
      // finds status !== 'pending', so it must NOT proceed to dispatch.
      const before = await statusOf("toctou");
      await real(id);
      // If the real fn had dispatched, it would have flipped status itself;
      // since the row was already 'complete', it short-circuits and the status
      // is unchanged.
      dispatchedTurn = (await statusOf("toctou")) !== before;
    });

    await __tickForTest(NOW);

    expect(dispatchedTurn).toBe(false);
    expect(await statusOf("toctou")).toBe("complete");
  });

  it("(d) a non-user_chat user pending row is surfaced as an invariant-violation WARN and left UNTOUCHED (no destructive flip, no synthetic error block)", async () => {
    // MEDIUM finding: a user-role `pending` row whose source is NOT 'user_chat'
    // violates the invariant (only sendUserMessage writes user 'pending', and
    // only as 'user_chat'). The reaper must NOT error-flip on source alone:
    // `RecordUserBlockInput.status` permits 'queued' for ANY source, so a future
    // in-flight queued non-user_chat block could land here and a destructive
    // flip would clobber it + emit a false "could not be delivered" bubble. So
    // we warn (observable) and leave the row alone.
    await insertBlockRow({
      id: "weird",
      status: "pending",
      tsMs: NOW - STALE_THRESHOLD_MS - 1_000,
      role: "user",
      source: "mail",
    });

    const spy = vi
      .spyOn(dispatchListener, "processPendingBlockRow")
      .mockImplementation(async () => {});
    const logSpy = vi.spyOn(log.logger, "log");

    await __tickForTest(NOW);

    // Never funneled through the dispatch entrypoint (it's undispatchable).
    expect(spy).not.toHaveBeenCalled();

    // Row is LEFT UNTOUCHED — not flipped to 'error' (a flip on source alone
    // could clobber a legit in-flight queued non-user_chat block).
    expect(await statusOf("weird")).toBe("pending");

    // No synthetic "could not be delivered" error block was inserted.
    const db = getDb();
    const errorBlocks = await db
      .select()
      .from(schema.blocks)
      .where(and(eq(schema.blocks.turnId, "t_weird"), eq(schema.blocks.kind, "error")));
    expect(errorBlocks).toHaveLength(0);

    // Non-silent: an invariant-violation warn was logged (loud signal to fix the
    // upstream writer).
    const warned = logSpy.mock.calls.find((c) => c[1] === "block.reaper.invariant-violation");
    expect(warned).toBeDefined();
  });

  it("(e) the scan does NOT touch a stale 'queued' user row (queued dropped from SCAN_STATUSES)", async () => {
    // MEDIUM finding: a `queued` user_chat row is a legitimately in-flight turn
    // parked behind a live worker. Scanning it (a) is a no-op via the dispatch
    // re-read but (b) emits a spurious stale-found warn + redispatch info every
    // tick until it drains. We scan `pending` only, so a stale `queued` row is
    // ignored entirely.
    await insertBlockRow({
      id: "queued-old",
      status: "queued",
      tsMs: NOW - STALE_THRESHOLD_MS - 10_000,
    });

    const spy = vi
      .spyOn(dispatchListener, "processPendingBlockRow")
      .mockImplementation(async () => {});
    const logSpy = vi.spyOn(log.logger, "log");

    await __tickForTest(NOW);

    expect(spy).not.toHaveBeenCalled();
    // Untouched and NOT noisy: no stale-found / redispatch noise for queued rows.
    expect(await statusOf("queued-old")).toBe("queued");
    expect(logSpy.mock.calls.find((c) => c[1] === "block.reaper.stale-found")).toBeUndefined();
    expect(logSpy.mock.calls.find((c) => c[1] === "block.reaper.redispatch")).toBeUndefined();
  });
});
