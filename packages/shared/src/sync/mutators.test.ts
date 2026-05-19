/**
 * Mutator unit tests (Phase 4.1).
 *
 * Each mutator runs against a mock `Transaction` that captures the
 * `tx.mutate.<table>.<op>(...)` calls. The assertions confirm:
 *   - The mutator writes the right rows with the right keys.
 *   - Re-running with the same args is idempotent (same write set —
 *     UPSERT collapses on PK, no side effects).
 *
 * The full client+server integration is exercised in the dashboard's
 * zero.test.ts (mutator dispatch + the markRead-on-snapshot wiring in
 * chat.test.ts). This file pins the mutator BODY independently.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createMutators,
  type ForgetDeviceArgs,
  type MarkReadArgs,
  type ReportClientStatsArgs,
} from "./mutators.js";

interface MockUpsertCall {
  device_id: string;
  agent_name: string;
  last_seen_block_id: string;
  ts: number;
}

interface MockClientDeviceUpdateCall {
  device_id: string;
  last_seen_at: number;
  last_sync_at: number;
  storage_used_bytes?: number;
  storage_quota_bytes?: number;
}

interface MockClientDeviceDeleteCall {
  device_id: string;
}

function makeMockTx(): {
  tx: Parameters<ReturnType<typeof createMutators>["markRead"]>[0];
  upsertCalls: MockUpsertCall[];
  clientDeviceUpdates: MockClientDeviceUpdateCall[];
  clientDeviceDeletes: MockClientDeviceDeleteCall[];
} {
  const upsertCalls: MockUpsertCall[] = [];
  const clientDeviceUpdates: MockClientDeviceUpdateCall[] = [];
  const clientDeviceDeletes: MockClientDeviceDeleteCall[] = [];
  const upsert = vi.fn(async (row: MockUpsertCall) => {
    upsertCalls.push(row);
  });
  const clientUpdate = vi.fn(async (row: MockClientDeviceUpdateCall) => {
    clientDeviceUpdates.push(row);
  });
  const clientDelete = vi.fn(async (row: MockClientDeviceDeleteCall) => {
    clientDeviceDeletes.push(row);
  });
  // The mutators touch `tx.mutate.<table>.<op>`. Rest of Transaction
  // surface left undefined — we cast to the parameter type only to
  // satisfy TypeScript.
  const tx = {
    mutate: {
      read_cursors: { upsert },
      client_devices: { update: clientUpdate, delete: clientDelete },
    },
  } as unknown as Parameters<ReturnType<typeof createMutators>["markRead"]>[0];
  return { tx, upsertCalls, clientDeviceUpdates, clientDeviceDeletes };
}

describe("markRead", () => {
  it("UPSERTs read_cursors with (device_id, agent_name) as the PK", async () => {
    const mutators = createMutators();
    const { tx, upsertCalls } = makeMockTx();
    const args: MarkReadArgs = {
      deviceId: "dev-1",
      agentName: "friday",
      lastSeenBlockId: "blk-7",
      ts: 1_700_000_000_000,
    };
    await mutators.markRead(tx, args);
    expect(upsertCalls).toEqual([
      {
        device_id: "dev-1",
        agent_name: "friday",
        last_seen_block_id: "blk-7",
        ts: 1_700_000_000_000,
      },
    ]);
  });

  it("is idempotent on PK — re-running with identical args produces an identical second write", async () => {
    // Idempotency contract from plan §5: re-executing a mutator with
    // the same args is a no-op at the row level. UPSERT semantics
    // collapse the duplicate; the test asserts the write set is
    // ALSO identical (no rehash, no clock-drift artifact).
    const mutators = createMutators();
    const { tx, upsertCalls } = makeMockTx();
    const args: MarkReadArgs = {
      deviceId: "dev-1",
      agentName: "friday",
      lastSeenBlockId: "blk-7",
      ts: 1_700_000_000_000,
    };
    await mutators.markRead(tx, args);
    await mutators.markRead(tx, args);
    expect(upsertCalls).toHaveLength(2);
    expect(upsertCalls[0]).toEqual(upsertCalls[1]);
  });

  it("advances the cursor monotonically — newer blockId overwrites older", async () => {
    const mutators = createMutators();
    const { tx, upsertCalls } = makeMockTx();
    await mutators.markRead(tx, {
      deviceId: "dev-1",
      agentName: "friday",
      lastSeenBlockId: "blk-1",
      ts: 100,
    });
    await mutators.markRead(tx, {
      deviceId: "dev-1",
      agentName: "friday",
      lastSeenBlockId: "blk-2",
      ts: 200,
    });
    expect(upsertCalls).toHaveLength(2);
    // Both writes target the same PK; the second-arrived write wins
    // server-side (UPSERT semantics). The mutator emits BOTH writes —
    // dedup happens in the dashboard's `chat.applyZeroBlocks` memo.
    expect(upsertCalls[0].last_seen_block_id).toBe("blk-1");
    expect(upsertCalls[1].last_seen_block_id).toBe("blk-2");
  });

  it("respects the per-device boundary — same agent, different devices, are distinct rows", async () => {
    // Per ADR-023 open-question default, read_cursors is keyed by
    // (device_id, agent_name). Two devices marking the same agent
    // produce two rows.
    const mutators = createMutators();
    const { tx, upsertCalls } = makeMockTx();
    await mutators.markRead(tx, {
      deviceId: "phone",
      agentName: "friday",
      lastSeenBlockId: "blk-1",
      ts: 100,
    });
    await mutators.markRead(tx, {
      deviceId: "laptop",
      agentName: "friday",
      lastSeenBlockId: "blk-1",
      ts: 100,
    });
    expect(upsertCalls.map((c) => c.device_id)).toEqual(["phone", "laptop"]);
  });
});

describe("reportClientStats", () => {
  it("UPDATEs client_devices with storage stats + ts", async () => {
    const mutators = createMutators();
    const { tx, clientDeviceUpdates } = makeMockTx();
    const args: ReportClientStatsArgs = {
      deviceId: "dev-1",
      storageUsedBytes: 12_345,
      storageQuotaBytes: 999_999,
      ts: 1_700_000_000_000,
    };
    await mutators.reportClientStats(tx, args);
    expect(clientDeviceUpdates).toEqual([
      {
        device_id: "dev-1",
        last_seen_at: 1_700_000_000_000,
        last_sync_at: 1_700_000_000_000,
        storage_used_bytes: 12_345,
        storage_quota_bytes: 999_999,
      },
    ]);
  });

  it("supports missing storage fields (older Safari, embedded WebViews)", async () => {
    const mutators = createMutators();
    const { tx, clientDeviceUpdates } = makeMockTx();
    await mutators.reportClientStats(tx, {
      deviceId: "dev-1",
      ts: 500,
      // storageUsedBytes and storageQuotaBytes omitted
    });
    expect(clientDeviceUpdates).toHaveLength(1);
    expect(clientDeviceUpdates[0]!.device_id).toBe("dev-1");
    expect(clientDeviceUpdates[0]!.last_seen_at).toBe(500);
    expect(clientDeviceUpdates[0]!.storage_used_bytes).toBeUndefined();
    expect(clientDeviceUpdates[0]!.storage_quota_bytes).toBeUndefined();
  });

  it("is idempotent on PK — re-running with same args produces identical writes", async () => {
    const mutators = createMutators();
    const { tx, clientDeviceUpdates } = makeMockTx();
    const args: ReportClientStatsArgs = {
      deviceId: "dev-1",
      storageUsedBytes: 100,
      storageQuotaBytes: 1_000,
      ts: 1,
    };
    await mutators.reportClientStats(tx, args);
    await mutators.reportClientStats(tx, args);
    expect(clientDeviceUpdates).toHaveLength(2);
    expect(clientDeviceUpdates[0]).toEqual(clientDeviceUpdates[1]);
  });

  it("does NOT touch user_id, first_seen_at, label, or user_agent — those are server-controlled", async () => {
    const mutators = createMutators();
    const { tx, clientDeviceUpdates } = makeMockTx();
    await mutators.reportClientStats(tx, {
      deviceId: "dev-1",
      storageUsedBytes: 1,
      storageQuotaBytes: 2,
      ts: 3,
    });
    const row = clientDeviceUpdates[0] as Record<string, unknown>;
    expect("user_id" in row).toBe(false);
    expect("first_seen_at" in row).toBe(false);
    expect("label" in row).toBe(false);
    expect("user_agent" in row).toBe(false);
  });
});

describe("forgetDevice", () => {
  it("DELETEs the client_devices row by device_id", async () => {
    const mutators = createMutators();
    const { tx, clientDeviceDeletes } = makeMockTx();
    const args: ForgetDeviceArgs = { deviceId: "dev-evict" };
    await mutators.forgetDevice(tx, args);
    expect(clientDeviceDeletes).toEqual([{ device_id: "dev-evict" }]);
  });

  it("is idempotent — re-running with same args produces identical deletes (no-op server-side)", async () => {
    const mutators = createMutators();
    const { tx, clientDeviceDeletes } = makeMockTx();
    const args: ForgetDeviceArgs = { deviceId: "dev-evict" };
    await mutators.forgetDevice(tx, args);
    await mutators.forgetDevice(tx, args);
    expect(clientDeviceDeletes).toHaveLength(2);
    expect(clientDeviceDeletes[0]).toEqual(clientDeviceDeletes[1]);
  });
});
