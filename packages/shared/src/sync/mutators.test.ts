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
import { createMutators, type MarkReadArgs } from "./mutators.js";

interface MockUpsertCall {
  device_id: string;
  agent_name: string;
  last_seen_block_id: string;
  ts: number;
}

function makeMockTx(): {
  tx: Parameters<ReturnType<typeof createMutators>["markRead"]>[0];
  upsertCalls: MockUpsertCall[];
} {
  const upsertCalls: MockUpsertCall[] = [];
  const upsert = vi.fn(async (row: MockUpsertCall) => {
    upsertCalls.push(row);
  });
  // The mutator only touches `tx.mutate.read_cursors.upsert`. The rest
  // of the Transaction surface can be left undefined — we cast to the
  // parameter type only to satisfy TypeScript.
  const tx = {
    mutate: {
      read_cursors: { upsert },
    },
    // Unused branches: querying, inserting, deleting, etc. Mutators
    // that need them get their own mock harness.
  } as unknown as Parameters<ReturnType<typeof createMutators>["markRead"]>[0];
  return { tx, upsertCalls };
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
