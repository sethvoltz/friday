/**
 * @vitest-environment jsdom
 *
 * FRI-103 regression suite for the localStorage-backed sendQueue. The
 * bug fix this pins: a sendQueue entry was being held in localStorage
 * (status=retrying) AFTER the canonical user `blocks` row had already
 * landed in Postgres and replicated back via Zero — producing a
 * permanent ghost bubble across hard refresh.
 *
 * Pinned contracts (Seth's data-safety constraint, decided 2026-05-21):
 *
 *   1. `enqueue` pre-mints a UUIDv4 `queueBlockId` and persists it with
 *      the queue entry.
 *   2. Every retry of the same logical send reuses that `queueBlockId`
 *      (threaded through `zeroSync.sendUserMessage`) so the canonical
 *      `blocks.id` PK is the natural dedup boundary.
 *   3. The entry is removed by `ackByBlockId` when the canonical row
 *      shows up in the Zero replica. PG is the source of truth — no
 *      silent data loss is possible: if the row never lands, the entry
 *      persists until MAX_ATTEMPTS or user action.
 *   4. The flush-success path's `remove(id)` stays as defense-in-depth,
 *      idempotent against `ackByBlockId`.
 *
 * Mocks the IO boundary (`loadJSON` / `saveJSON` / `zeroSync.sendUserMessage`)
 * and leaves the Svelte $state reactivity real, so assertions exercise
 * the same code path the browser runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// IO-boundary mocks: persistent.ts + zero.svelte (the sendQueue's only
// outbound dependencies).
// ---------------------------------------------------------------------------

const mockLoadJSON = vi.fn();
const mockSaveJSON = vi.fn();
vi.mock("$lib/stores/persistent", () => ({
  loadJSON: mockLoadJSON,
  saveJSON: mockSaveJSON,
  KEYS: { sendQueue: "sendQueue" },
}));

// `useZero()` returns true so flush takes the Zero path (not the legacy
// REST fallback). `sendUserMessage` is the per-test boundary the assertions
// drive.
const mockSendUserMessage = vi.fn();
const mockUseZero = vi.fn(() => true);
vi.mock("$lib/stores/zero.svelte", () => ({
  useZero: mockUseZero,
  zeroSync: {
    sendUserMessage: mockSendUserMessage,
  },
}));

beforeEach(() => {
  mockLoadJSON.mockReset();
  mockSaveJSON.mockReset();
  mockSendUserMessage.mockReset();
  mockUseZero.mockReset();
  mockUseZero.mockReturnValue(true);
  mockLoadJSON.mockReturnValue([]);
  // The module under test caches its singleton at import time; reset
  // modules between tests so each test gets a fresh SendQueue with
  // hydrated state derived from THIS test's mockLoadJSON return.
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllTimers();
});

// ---------------------------------------------------------------------------
// AC1: enqueue pre-mints queueBlockId, persists it, and the success path
// after a retry clears the entry via the ack hook.
// ---------------------------------------------------------------------------

describe("FRI-103 AC1: clears localStorage entry once the canonical block lands", () => {
  it("clears localStorage entry once the canonical block lands", async () => {
    mockLoadJSON.mockReturnValue([]);
    const { sendQueue } = await import("./send-queue.svelte");

    // (1) enqueue + assert saveJSON wrote a UUID-shaped queueBlockId.
    const enqueued = sendQueue.enqueue({ agent: "friday", text: "#43 merged" });
    expect(mockSaveJSON).toHaveBeenCalled();
    const lastSave = mockSaveJSON.mock.calls.at(-1)!;
    expect(lastSave[0]).toBe("sendQueue");
    expect(lastSave[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: "friday",
          text: "#43 merged",
          attempts: 0,
          queueBlockId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
      ]),
    );
    const queueBlockId = enqueued.queueBlockId;
    expect(queueBlockId).toMatch(/^[0-9a-f-]{36}$/);

    // (2) flush #1: simulate Zero-not-ready → null return → retrying.
    mockSendUserMessage.mockResolvedValueOnce(null);
    const result = await sendQueue.flush();
    expect(result).toEqual({ sent: [], failed: [], retrying: [enqueued.id] });

    // Persisted shape after retry: attempts=1, status=retrying, same
    // queueBlockId.
    const postFlushSave = mockSaveJSON.mock.calls.at(-1)!;
    expect(postFlushSave[1]).toEqual([
      expect.objectContaining({
        id: enqueued.id,
        attempts: 1,
        status: "retrying",
        queueBlockId,
      }),
    ]);

    // (3) Simulate the canonical block landing via Zero → applyZeroBlocks
    // calls ackByBlockId. Entry is gone, persisted as [].
    sendQueue.ackByBlockId(queueBlockId);
    expect(sendQueue.items).toEqual([]);
    const finalSave = mockSaveJSON.mock.calls.at(-1)!;
    expect(finalSave[0]).toBe("sendQueue");
    expect(finalSave[1]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC3: reload-mid-retry: rehydration does not resurrect a ghost whose
// canonical block already landed.
// ---------------------------------------------------------------------------

describe("FRI-103 AC3: reload-mid-retry rehydration + ack drains the ghost", () => {
  it("reload-mid-retry: rehydration does not resurrect a ghost whose canonical block already landed", async () => {
    const queueBlockId = "70df2671-7d96-45c7-83bf-28bfd0317f2a";
    // Seed localStorage as if a prior session had failed twice and
    // persisted attempts=2,status=retrying.
    mockLoadJSON.mockReturnValue([
      {
        id: "q_test",
        agent: "friday",
        text: "#43 merged",
        attempts: 2,
        status: "retrying",
        queueBlockId,
        createdAt: 1_747_000_000_000,
      },
    ]);

    // Re-import to construct a fresh SendQueue against the seeded
    // localStorage (vi.resetModules in beforeEach guarantees this).
    const { sendQueue } = await import("./send-queue.svelte");
    expect(sendQueue.items).toHaveLength(1);
    expect(sendQueue.items[0]!.queueBlockId).toBe(queueBlockId);

    // Simulate applyZeroBlocks seeing the canonical row in Zero's first
    // post-reload snapshot.
    sendQueue.ackByBlockId(queueBlockId);

    expect(sendQueue.items).toEqual([]);
    // The most recent persist call must have written [].
    const lastSave = mockSaveJSON.mock.calls.at(-1)!;
    expect(lastSave[0]).toBe("sendQueue");
    expect(lastSave[1]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC4: both interleavings of optimistic ↔ canonical convergence.
// ---------------------------------------------------------------------------

describe("FRI-103 AC4: optimistic ↔ canonical convergence (both interleavings)", () => {
  it("canonical-first: Zero snapshot arrives before flush returns", async () => {
    // The race: enqueue → flush kicks off → sendUserMessage's promise
    // is still pending → Zero replication arrives early → ackByBlockId
    // splices the entry out → then sendUserMessage resolves and the
    // success path tries to remove(id) (must be a no-op, not a throw).
    mockLoadJSON.mockReturnValue([]);
    const { sendQueue } = await import("./send-queue.svelte");
    const enqueued = sendQueue.enqueue({ agent: "friday", text: "race" });
    const queueBlockId = enqueued.queueBlockId;

    // Build a deferred so we control when flush's await resolves.
    let resolveSend!: (
      v: { blockId: string; turnId: string } | null,
    ) => void;
    mockSendUserMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );

    const flushPromise = sendQueue.flush();

    // Canonical row arrives BEFORE flush has a chance to complete.
    sendQueue.ackByBlockId(queueBlockId);
    expect(sendQueue.items).toEqual([]);

    // Now resolve the flush — success path runs `this.remove(id)`.
    // That must be a no-op (item already spliced) and must not throw.
    resolveSend({ blockId: queueBlockId, turnId: `t_${queueBlockId}` });
    const result = await flushPromise;

    // The flush still reports it as `sent` (the call succeeded after
    // all), but the queue is empty and no double-remove happened.
    expect(result.sent).toEqual([
      {
        queueId: enqueued.id,
        turnId: `t_${queueBlockId}`,
        agent: "friday",
        queued: false,
      },
    ]);
    expect(sendQueue.items).toEqual([]);
  });

  it("flush-first: success path before Zero snapshot", async () => {
    // The opposite race: sendUserMessage resolves immediately. The
    // flush success path calls remove(id) directly. The queue is
    // empty BEFORE Zero replication. Then the canonical row arrives;
    // ackByBlockId is a no-op (idempotent against a non-existent
    // entry).
    mockLoadJSON.mockReturnValue([]);
    const { sendQueue } = await import("./send-queue.svelte");
    const enqueued = sendQueue.enqueue({ agent: "friday", text: "race2" });
    const queueBlockId = enqueued.queueBlockId;
    mockSendUserMessage.mockResolvedValueOnce({
      blockId: queueBlockId,
      turnId: `t_${queueBlockId}`,
    });

    const result = await sendQueue.flush();
    expect(sendQueue.items).toEqual([]);
    expect(result.sent[0]!.queueId).toBe(enqueued.id);

    // Canonical row arrives "late"; ack is a no-op, no throw.
    expect(() => sendQueue.ackByBlockId(queueBlockId)).not.toThrow();
    expect(sendQueue.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC6: pre-minted blockId is reused across retries (Seth's data-safety
// constraint).
// ---------------------------------------------------------------------------

describe("FRI-103 AC6: pre-minted blockId is reused across retries", () => {
  it("retry across Zero-not-ready preserves single canonical block_id", async () => {
    mockLoadJSON.mockReturnValue([]);
    const { sendQueue } = await import("./send-queue.svelte");
    const enqueued = sendQueue.enqueue({ agent: "friday", text: "retryme" });
    const queueBlockId = enqueued.queueBlockId;

    // First flush: Zero not ready → null. The mock was called with the
    // pre-minted blockId.
    mockSendUserMessage.mockResolvedValueOnce(null);
    await sendQueue.flush();

    // Second flush: success. Must be called with the SAME blockId — the
    // dedup-via-PK contract.
    mockSendUserMessage.mockResolvedValueOnce({
      blockId: queueBlockId,
      turnId: `t_${queueBlockId}`,
    });
    await sendQueue.flush();

    expect(mockSendUserMessage).toHaveBeenCalledTimes(2);
    const firstCallArg = mockSendUserMessage.mock.calls[0]![0] as {
      blockId: string;
    };
    const secondCallArg = mockSendUserMessage.mock.calls[1]![0] as {
      blockId: string;
    };
    expect(firstCallArg.blockId).toBe(queueBlockId);
    expect(secondCallArg.blockId).toBe(queueBlockId);
    // The load-bearing AC6 assertion: same id across retries.
    expect(secondCallArg.blockId).toBe(firstCallArg.blockId);
  });
});

// ---------------------------------------------------------------------------
// AC7: durable-write safety. A queue entry whose canonical block never
// lands stays in localStorage until MAX_ATTEMPTS or user action — no
// silent data loss.
// ---------------------------------------------------------------------------

describe("FRI-103 AC7: queue entry persists when canonical block never arrives", () => {
  it("queue entry persists across reload when canonical block never arrives", async () => {
    const queueBlockId = "70df2671-7d96-45c7-83bf-28bfd0317f2a";
    const seeded = {
      id: "q_test",
      agent: "friday",
      text: "still here",
      attempts: 2,
      status: "retrying" as const,
      queueBlockId,
      createdAt: 1_747_000_000_000,
    };
    mockLoadJSON.mockReturnValue([seeded]);

    const { sendQueue } = await import("./send-queue.svelte");
    expect(sendQueue.items).toHaveLength(1);

    // applyZeroBlocks would call ackByBlockId for each user row in
    // the snapshot. Simulate a snapshot that includes only UNRELATED
    // block_ids (e.g. older messages from another session) — the
    // entry's queueBlockId is NOT present.
    sendQueue.ackByBlockId("unrelated-block-id-1");
    sendQueue.ackByBlockId("unrelated-block-id-2");

    // Entry still here, untouched.
    expect(sendQueue.items).toEqual([
      {
        id: "q_test",
        agent: "friday",
        text: "still here",
        attempts: 2,
        status: "retrying",
        queueBlockId,
        createdAt: 1_747_000_000_000,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC5 lives in chat.test.ts (it's a chat-layer contract). Keeping a
// sentinel block here just to document the layout.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FRI-104 cross-boundary tests: pin the sendQueue ↔ sendUserMessage
// contract after FRI-104 collapses the dead-code try/catch in the
// wrapper into a typed `awaitMutatorServer` branch.
//
// AC #6: data-safety carry-over from FRI-103. A non-PK app-error from
// sendUserMessage returns `null`; the wrapper's job is to not silently
// remove the entry. The existing `null`-return path in
// send-queue.svelte.ts:247-263 increments `attempts`, sets
// `lastError = "zero_not_ready"`, and persists. We don't differentiate
// the `lastError` text per cause yet — the invariant is "entry survives".
//
// AC #7: PK collision on a retry is a dedup success. The wrapper returns
// `{blockId, turnId}` (verified in zero.test.ts); from sendQueue's
// perspective the flow is identical to a first-push success — `remove(id)`
// runs and `sent[]` lists the entry.
// ---------------------------------------------------------------------------

describe("FRI-104: cross-boundary contract for sendUserMessage typed outcomes", () => {
  it("flush does NOT remove the queue entry when sendUserMessage returns null due to a non-PK app error", async () => {
    mockLoadJSON.mockReturnValue([]);
    const { sendQueue } = await import("./send-queue.svelte");
    sendQueue.enqueue({ agent: "friday", text: "non-pk failure" });
    mockSendUserMessage.mockResolvedValueOnce(null);

    await sendQueue.flush();

    expect(sendQueue.items).toHaveLength(1);
    expect(sendQueue.items[0]).toMatchObject({
      attempts: 1,
      status: "retrying",
      lastError: "zero_not_ready",
    });
  });

  it("flush removes the queue entry on PK-collision retry (dedup is success)", async () => {
    mockLoadJSON.mockReturnValue([]);
    const { sendQueue } = await import("./send-queue.svelte");
    const enqueued = sendQueue.enqueue({
      agent: "friday",
      text: "pk-dedup success",
    });
    const queueBlockId = enqueued.queueBlockId;
    // PK-collision-on-retry is classified by the wrapper as success and
    // returns the canonical {blockId, turnId} shape (see zero.test.ts
    // "sendUserMessage returns {blockId, turnId} when server resolves to
    // {type:'error', error:{type:'app'}} that matches a blocks_pkey PK
    // collision (idempotent retry)").
    mockSendUserMessage.mockResolvedValueOnce({
      blockId: queueBlockId,
      turnId: `t_${queueBlockId}`,
    });

    const result = await sendQueue.flush();

    expect(sendQueue.items).toHaveLength(0);
    expect(result.sent).toMatchObject([
      {
        queueId: enqueued.id,
        turnId: `t_${queueBlockId}`,
        agent: "friday",
        queued: false,
      },
    ]);
  });
});
