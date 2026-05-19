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
  nextTicketIdFrom,
  slugifyMemoryId,
  type AddTicketCommentArgs,
  type AddTicketRelationArgs,
  type ArchiveAgentArgs,
  type CancelQueuedArgs,
  type CreateMemoryEntryArgs,
  type CreateScheduleArgs,
  type CreateTicketArgs,
  type DeleteMemoryEntryArgs,
  type DeleteScheduleArgs,
  type ForgetDeviceArgs,
  type InstallAppArgs,
  type LinkTicketExternalArgs,
  type MarkReadArgs,
  type ReloadAppArgs,
  type ReportClientStatsArgs,
  type UninstallAppArgs,
  type UpdateMemoryEntryArgs,
  type UpdateScheduleArgs,
  type UpdateSettingsArgs,
  type UpdateTicketArgs,
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

interface MockSettingsUpdateCall {
  id: string;
  model?: string;
  watchdog_refork?: boolean;
  updated_at: number;
}

interface MockTicketInsertCall {
  id: string;
  title: string;
  body?: string;
  status: string;
  kind: string;
  assignee?: string;
  meta_json?: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

interface MockTicketUpdateCall {
  id: string;
  title?: string;
  body?: string | null;
  status?: string;
  kind?: string;
  assignee?: string | null;
  meta_json?: Record<string, unknown> | null;
  updated_at: number;
}

interface MockTicketCommentInsertCall {
  id: string;
  ticket_id: string;
  author: string;
  body: string;
  ts: number;
}

interface MockTicketRelationInsertCall {
  parent_id: string;
  child_id: string;
  kind: string;
}

interface MockTicketExternalLinkInsertCall {
  ticket_id: string;
  system: string;
  external_id: string;
  url?: string;
  meta_json?: Record<string, unknown>;
  linked_at: number;
}

interface MockMemoryInsertCall {
  id: string;
  title: string;
  content: string;
  tags_json: string[];
  created_by: string;
  created_at: number;
  updated_at: number;
  file_mtime: number;
  recall_count: number;
  last_recalled_at: number | null;
  status: string;
}

interface MockMemoryUpdateCall {
  id: string;
  title?: string;
  content?: string;
  tags_json?: string[];
  updated_at: number;
  status: string;
}

interface MockScheduleInsertCall {
  name: string;
  cron?: string;
  run_at?: string;
  task_prompt: string;
  paused: boolean;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_id: string | null;
  meta_json: Record<string, unknown> | null;
  app_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

interface MockScheduleUpdateCall {
  name: string;
  cron?: string | null;
  run_at?: string | null;
  task_prompt?: string;
  paused?: boolean;
  updated_at: number;
  status: string;
}

interface MockAppInsertCall {
  id: string;
  name: string;
  version: string;
  manifest_version: number;
  folder_path: string;
  manifest_json: Record<string, unknown>;
  status: string;
  installed_at: number;
  upgraded_at: number | null;
  meta_json: Record<string, unknown> | null;
}

interface MockAppUpdateCall {
  id: string;
  status: string;
}

interface MockAgentUpdateCall {
  name: string;
  status: string;
  archive_reason?: string;
  updated_at: number;
}

interface MockBlocksUpdateCall {
  id: number;
  status: string;
}

function makeMockTx(): {
  tx: Parameters<ReturnType<typeof createMutators>["markRead"]>[0];
  upsertCalls: MockUpsertCall[];
  clientDeviceUpdates: MockClientDeviceUpdateCall[];
  clientDeviceDeletes: MockClientDeviceDeleteCall[];
  settingsUpdates: MockSettingsUpdateCall[];
  ticketInserts: MockTicketInsertCall[];
  ticketUpdates: MockTicketUpdateCall[];
  ticketCommentInserts: MockTicketCommentInsertCall[];
  ticketRelationInserts: MockTicketRelationInsertCall[];
  ticketExternalLinkInserts: MockTicketExternalLinkInsertCall[];
  memoryInserts: MockMemoryInsertCall[];
  memoryUpdates: MockMemoryUpdateCall[];
  scheduleInserts: MockScheduleInsertCall[];
  scheduleUpdates: MockScheduleUpdateCall[];
  appInserts: MockAppInsertCall[];
  appUpdates: MockAppUpdateCall[];
  agentUpdates: MockAgentUpdateCall[];
  blocksUpdates: MockBlocksUpdateCall[];
} {
  const upsertCalls: MockUpsertCall[] = [];
  const clientDeviceUpdates: MockClientDeviceUpdateCall[] = [];
  const clientDeviceDeletes: MockClientDeviceDeleteCall[] = [];
  const settingsUpdates: MockSettingsUpdateCall[] = [];
  const ticketInserts: MockTicketInsertCall[] = [];
  const ticketUpdates: MockTicketUpdateCall[] = [];
  const ticketCommentInserts: MockTicketCommentInsertCall[] = [];
  const ticketRelationInserts: MockTicketRelationInsertCall[] = [];
  const ticketExternalLinkInserts: MockTicketExternalLinkInsertCall[] = [];
  const upsert = vi.fn(async (row: MockUpsertCall) => {
    upsertCalls.push(row);
  });
  const clientUpdate = vi.fn(async (row: MockClientDeviceUpdateCall) => {
    clientDeviceUpdates.push(row);
  });
  const clientDelete = vi.fn(async (row: MockClientDeviceDeleteCall) => {
    clientDeviceDeletes.push(row);
  });
  const settingsUpdate = vi.fn(async (row: MockSettingsUpdateCall) => {
    settingsUpdates.push(row);
  });
  const ticketInsert = vi.fn(async (row: MockTicketInsertCall) => {
    ticketInserts.push(row);
  });
  const ticketUpdate = vi.fn(async (row: MockTicketUpdateCall) => {
    ticketUpdates.push(row);
  });
  const ticketCommentInsert = vi.fn(
    async (row: MockTicketCommentInsertCall) => {
      ticketCommentInserts.push(row);
    },
  );
  const ticketRelationInsert = vi.fn(
    async (row: MockTicketRelationInsertCall) => {
      ticketRelationInserts.push(row);
    },
  );
  const ticketExternalLinkInsert = vi.fn(
    async (row: MockTicketExternalLinkInsertCall) => {
      ticketExternalLinkInserts.push(row);
    },
  );
  const memoryInserts: MockMemoryInsertCall[] = [];
  const memoryUpdates: MockMemoryUpdateCall[] = [];
  const memoryInsert = vi.fn(async (row: MockMemoryInsertCall) => {
    memoryInserts.push(row);
  });
  const memoryUpdate = vi.fn(async (row: MockMemoryUpdateCall) => {
    memoryUpdates.push(row);
  });
  const scheduleInserts: MockScheduleInsertCall[] = [];
  const scheduleUpdates: MockScheduleUpdateCall[] = [];
  const scheduleInsert = vi.fn(async (row: MockScheduleInsertCall) => {
    scheduleInserts.push(row);
  });
  const scheduleUpdate = vi.fn(async (row: MockScheduleUpdateCall) => {
    scheduleUpdates.push(row);
  });
  const appInserts: MockAppInsertCall[] = [];
  const appUpdates: MockAppUpdateCall[] = [];
  const appInsert = vi.fn(async (row: MockAppInsertCall) => {
    appInserts.push(row);
  });
  const appUpdate = vi.fn(async (row: MockAppUpdateCall) => {
    appUpdates.push(row);
  });
  const agentUpdates: MockAgentUpdateCall[] = [];
  const agentUpdate = vi.fn(async (row: MockAgentUpdateCall) => {
    agentUpdates.push(row);
  });
  const blocksUpdates: MockBlocksUpdateCall[] = [];
  const blocksUpdate = vi.fn(async (row: MockBlocksUpdateCall) => {
    blocksUpdates.push(row);
  });
  // The mutators touch `tx.mutate.<table>.<op>`. Rest of Transaction
  // surface left undefined — we cast to the parameter type only to
  // satisfy TypeScript.
  const tx = {
    mutate: {
      read_cursors: { upsert },
      client_devices: { update: clientUpdate, delete: clientDelete },
      settings: { update: settingsUpdate },
      tickets: { insert: ticketInsert, update: ticketUpdate },
      ticket_comments: { insert: ticketCommentInsert },
      ticket_relations: { insert: ticketRelationInsert },
      ticket_external_links: { insert: ticketExternalLinkInsert },
      memory_entries: { insert: memoryInsert, update: memoryUpdate },
      schedules: { insert: scheduleInsert, update: scheduleUpdate },
      apps: { insert: appInsert, update: appUpdate },
      agents: { update: agentUpdate },
      blocks: { update: blocksUpdate },
    },
  } as unknown as Parameters<ReturnType<typeof createMutators>["markRead"]>[0];
  return {
    tx,
    upsertCalls,
    clientDeviceUpdates,
    clientDeviceDeletes,
    settingsUpdates,
    ticketInserts,
    ticketUpdates,
    ticketCommentInserts,
    ticketRelationInserts,
    ticketExternalLinkInserts,
    memoryInserts,
    memoryUpdates,
    scheduleInserts,
    scheduleUpdates,
    appInserts,
    appUpdates,
    agentUpdates,
    blocksUpdates,
  };
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

describe("updateSettings", () => {
  it("UPDATEs settings singleton with model when provided", async () => {
    const mutators = createMutators();
    const { tx, settingsUpdates } = makeMockTx();
    const args: UpdateSettingsArgs = {
      model: "claude-opus-4-7",
      ts: 1_700_000_000_000,
    };
    await mutators.updateSettings(tx, args);
    expect(settingsUpdates).toEqual([
      {
        id: "singleton",
        model: "claude-opus-4-7",
        updated_at: 1_700_000_000_000,
      },
    ]);
  });

  it("UPDATEs settings singleton with watchdogRefork when provided", async () => {
    const mutators = createMutators();
    const { tx, settingsUpdates } = makeMockTx();
    await mutators.updateSettings(tx, {
      watchdogRefork: false,
      ts: 1,
    });
    expect(settingsUpdates).toEqual([
      {
        id: "singleton",
        watchdog_refork: false,
        updated_at: 1,
      },
    ]);
  });

  it("UPDATEs both fields when both are provided", async () => {
    const mutators = createMutators();
    const { tx, settingsUpdates } = makeMockTx();
    await mutators.updateSettings(tx, {
      model: "claude-sonnet-4-6",
      watchdogRefork: true,
      ts: 999,
    });
    expect(settingsUpdates[0]).toEqual({
      id: "singleton",
      model: "claude-sonnet-4-6",
      watchdog_refork: true,
      updated_at: 999,
    });
  });

  it("omits fields that weren't provided (preserves existing values via Zero's update semantic)", async () => {
    // Critical contract — `update` (not `upsert`) means absent keys
    // preserve their current Postgres values. A naive UPSERT with
    // undefined would clobber the omitted column to NULL.
    const mutators = createMutators();
    const { tx, settingsUpdates } = makeMockTx();
    await mutators.updateSettings(tx, { model: "x", ts: 5 });
    expect("watchdog_refork" in (settingsUpdates[0] ?? {})).toBe(false);
  });

  it("is idempotent on PK — re-running with same args produces identical writes", async () => {
    const mutators = createMutators();
    const { tx, settingsUpdates } = makeMockTx();
    const args: UpdateSettingsArgs = {
      model: "claude-opus-4-7",
      watchdogRefork: true,
      ts: 1,
    };
    await mutators.updateSettings(tx, args);
    await mutators.updateSettings(tx, args);
    expect(settingsUpdates).toHaveLength(2);
    expect(settingsUpdates[0]).toEqual(settingsUpdates[1]);
  });

  it("always targets the literal 'singleton' PK", async () => {
    // Defensive: the table is single-row by design; any other id
    // would silently create a parallel row. The mutator hardcodes
    // "singleton" — verify no path slips a different value through.
    const mutators = createMutators();
    const { tx, settingsUpdates } = makeMockTx();
    await mutators.updateSettings(tx, { model: "x", ts: 1 });
    await mutators.updateSettings(tx, { watchdogRefork: false, ts: 2 });
    expect(settingsUpdates.map((c) => c.id)).toEqual(["singleton", "singleton"]);
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

describe("nextTicketIdFrom", () => {
  it("returns FRI-1 from an empty snapshot", () => {
    expect(nextTicketIdFrom([])).toBe("FRI-1");
  });

  it("returns max(numeric_suffix) + 1", () => {
    expect(
      nextTicketIdFrom([{ id: "FRI-3" }, { id: "FRI-1" }, { id: "FRI-7" }]),
    ).toBe("FRI-8");
  });

  it("ignores non-FRI-pattern ids (defensive — shouldn't happen in practice)", () => {
    expect(
      nextTicketIdFrom([{ id: "FRI-5" }, { id: "other-id" }, { id: "FRI-10" }]),
    ).toBe("FRI-11");
  });

  it("returns FRI-1 if no ids match the FRI-N pattern", () => {
    expect(nextTicketIdFrom([{ id: "weird" }, { id: "uuid-shape" }])).toBe(
      "FRI-1",
    );
  });
});

describe("createTicket", () => {
  it("INSERTs tickets with the supplied id + default status/kind", async () => {
    const mutators = createMutators();
    const { tx, ticketInserts } = makeMockTx();
    await mutators.createTicket(tx, {
      id: "FRI-42",
      title: "Hello",
      ts: 1_000,
    } as CreateTicketArgs);
    expect(ticketInserts).toEqual([
      {
        id: "FRI-42",
        title: "Hello",
        body: undefined,
        status: "open",
        kind: "task",
        assignee: undefined,
        meta_json: undefined,
        created_at: 1_000,
        updated_at: 1_000,
      },
    ]);
  });

  it("honors explicit status, kind, body, assignee, meta", async () => {
    const mutators = createMutators();
    const { tx, ticketInserts } = makeMockTx();
    await mutators.createTicket(tx, {
      id: "FRI-9",
      title: "Custom",
      body: "details",
      status: "in_progress",
      kind: "bug",
      assignee: "alice",
      meta: { tags: ["urgent"] },
      ts: 5,
    });
    expect(ticketInserts[0]).toMatchObject({
      id: "FRI-9",
      title: "Custom",
      body: "details",
      status: "in_progress",
      kind: "bug",
      assignee: "alice",
      meta_json: { tags: ["urgent"] },
    });
  });

  it("stamps created_at = updated_at on initial insert", async () => {
    const mutators = createMutators();
    const { tx, ticketInserts } = makeMockTx();
    await mutators.createTicket(tx, {
      id: "FRI-1",
      title: "x",
      ts: 99,
    });
    expect(ticketInserts[0]!.created_at).toBe(ticketInserts[0]!.updated_at);
    expect(ticketInserts[0]!.created_at).toBe(99);
  });
});

describe("updateTicket", () => {
  it("UPDATEs only the fields that were provided", async () => {
    const mutators = createMutators();
    const { tx, ticketUpdates } = makeMockTx();
    await mutators.updateTicket(tx, {
      id: "FRI-1",
      status: "done",
      ts: 5,
    } as UpdateTicketArgs);
    expect(ticketUpdates).toHaveLength(1);
    const u = ticketUpdates[0]!;
    expect(u.id).toBe("FRI-1");
    expect(u.status).toBe("done");
    expect(u.updated_at).toBe(5);
    expect("title" in u).toBe(false);
    expect("body" in u).toBe(false);
    expect("kind" in u).toBe(false);
    expect("assignee" in u).toBe(false);
    expect("meta_json" in u).toBe(false);
  });

  it("always advances updated_at", async () => {
    const mutators = createMutators();
    const { tx, ticketUpdates } = makeMockTx();
    // Even with no field changes, updated_at advances. The dashboard
    // never calls updateTicket without at least one field, but
    // the contract guarantees the bump anyway.
    await mutators.updateTicket(tx, { id: "FRI-1", ts: 42 });
    expect(ticketUpdates[0]!.updated_at).toBe(42);
  });

  it("supports null body / assignee / meta (the unset operation)", async () => {
    const mutators = createMutators();
    const { tx, ticketUpdates } = makeMockTx();
    await mutators.updateTicket(tx, {
      id: "FRI-1",
      body: null,
      assignee: null,
      meta: null,
      ts: 1,
    });
    expect(ticketUpdates[0]!.body).toBeNull();
    expect(ticketUpdates[0]!.assignee).toBeNull();
    expect(ticketUpdates[0]!.meta_json).toBeNull();
  });
});

describe("addTicketComment", () => {
  it("INSERTs the comment AND bumps the parent ticket's updated_at", async () => {
    const mutators = createMutators();
    const { tx, ticketCommentInserts, ticketUpdates } = makeMockTx();
    await mutators.addTicketComment(tx, {
      id: "comment-uuid-1",
      ticketId: "FRI-1",
      author: "alice",
      body: "looks good",
      ts: 100,
    } as AddTicketCommentArgs);
    expect(ticketCommentInserts).toEqual([
      {
        id: "comment-uuid-1",
        ticket_id: "FRI-1",
        author: "alice",
        body: "looks good",
        ts: 100,
      },
    ]);
    // Critical: the comment insert must bump tickets.updated_at so
    // the list page's "sort by updated" reorders the parent ticket.
    expect(ticketUpdates).toEqual([{ id: "FRI-1", updated_at: 100 }]);
  });

  it("uses the same ts for both the comment and the ticket bump", async () => {
    const mutators = createMutators();
    const { tx, ticketCommentInserts, ticketUpdates } = makeMockTx();
    await mutators.addTicketComment(tx, {
      id: "uuid-x",
      ticketId: "FRI-2",
      author: "bob",
      body: "hello",
      ts: 555,
    });
    expect(ticketCommentInserts[0]!.ts).toBe(555);
    expect(ticketUpdates[0]!.updated_at).toBe(555);
  });
});

describe("addTicketRelation", () => {
  it("INSERTs the relation triple (parent_id, child_id, kind)", async () => {
    const mutators = createMutators();
    const { tx, ticketRelationInserts } = makeMockTx();
    await mutators.addTicketRelation(tx, {
      parentId: "FRI-1",
      childId: "FRI-2",
      kind: "blocks",
    } as AddTicketRelationArgs);
    expect(ticketRelationInserts).toEqual([
      { parent_id: "FRI-1", child_id: "FRI-2", kind: "blocks" },
    ]);
  });

  it("preserves the kind discriminator in the row (composite PK includes it)", async () => {
    // Two different relation kinds between the same pair are distinct
    // rows — the test verifies the kind passes through unchanged so
    // the PK uniqueness lands correctly.
    const mutators = createMutators();
    const { tx, ticketRelationInserts } = makeMockTx();
    await mutators.addTicketRelation(tx, {
      parentId: "FRI-1",
      childId: "FRI-2",
      kind: "depends_on",
    });
    await mutators.addTicketRelation(tx, {
      parentId: "FRI-1",
      childId: "FRI-2",
      kind: "blocks",
    });
    expect(ticketRelationInserts.map((r) => r.kind)).toEqual([
      "depends_on",
      "blocks",
    ]);
  });
});

describe("linkTicketExternal", () => {
  it("INSERTs the external-link row with linked_at = ts", async () => {
    const mutators = createMutators();
    const { tx, ticketExternalLinkInserts } = makeMockTx();
    await mutators.linkTicketExternal(tx, {
      ticketId: "FRI-1",
      system: "linear",
      externalId: "LIN-42",
      url: "https://linear.app/x/LIN-42",
      ts: 1_700_000_000_000,
    } as LinkTicketExternalArgs);
    expect(ticketExternalLinkInserts).toEqual([
      {
        ticket_id: "FRI-1",
        system: "linear",
        external_id: "LIN-42",
        url: "https://linear.app/x/LIN-42",
        meta_json: undefined,
        linked_at: 1_700_000_000_000,
      },
    ]);
  });

  it("supports meta_json", async () => {
    const mutators = createMutators();
    const { tx, ticketExternalLinkInserts } = makeMockTx();
    await mutators.linkTicketExternal(tx, {
      ticketId: "FRI-1",
      system: "github",
      externalId: "#123",
      meta: { repo: "anthropic/friday" },
      ts: 1,
    });
    expect(ticketExternalLinkInserts[0]!.meta_json).toEqual({
      repo: "anthropic/friday",
    });
  });
});

describe("slugifyMemoryId", () => {
  it("converts a title to lowercase-dashed slug", () => {
    expect(slugifyMemoryId("My Important Note")).toBe("my-important-note");
  });

  it("strips non-word characters", () => {
    expect(slugifyMemoryId("Hello, World! (2024)")).toBe("hello-world-2024");
  });

  it("collapses repeated dashes and trims edge dashes", () => {
    expect(slugifyMemoryId("  --hello---world--  ")).toBe("hello-world");
  });

  it("truncates to 64 chars", () => {
    const longTitle = "a".repeat(200);
    expect(slugifyMemoryId(longTitle).length).toBe(64);
  });
});

describe("createMemoryEntry", () => {
  it("INSERTs memory_entries at status='pending_file'", async () => {
    const mutators = createMutators();
    const { tx, memoryInserts } = makeMockTx();
    const args: CreateMemoryEntryArgs = {
      id: "my-note",
      title: "My Note",
      content: "Body text.",
      tags: ["alpha", "beta"],
      createdBy: "user",
      ts: 1_700_000_000_000,
    };
    await mutators.createMemoryEntry(tx, args);
    expect(memoryInserts).toEqual([
      {
        id: "my-note",
        title: "My Note",
        content: "Body text.",
        tags_json: ["alpha", "beta"],
        created_by: "user",
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        file_mtime: 1_700_000_000_000,
        recall_count: 0,
        last_recalled_at: null,
        status: "pending_file",
      },
    ]);
  });

  it("created_at = updated_at = file_mtime = ts on initial INSERT", async () => {
    const mutators = createMutators();
    const { tx, memoryInserts } = makeMockTx();
    await mutators.createMemoryEntry(tx, {
      id: "x",
      title: "X",
      content: "",
      tags: [],
      createdBy: "user",
      ts: 999,
    });
    expect(memoryInserts[0]!.created_at).toBe(999);
    expect(memoryInserts[0]!.updated_at).toBe(999);
    expect(memoryInserts[0]!.file_mtime).toBe(999);
  });

  it("status is always 'pending_file' on insert (never 'ready' — that's the daemon's job)", async () => {
    const mutators = createMutators();
    const { tx, memoryInserts } = makeMockTx();
    await mutators.createMemoryEntry(tx, {
      id: "y",
      title: "Y",
      content: "",
      tags: [],
      createdBy: "u",
      ts: 1,
    });
    expect(memoryInserts[0]!.status).toBe("pending_file");
  });
});

describe("updateMemoryEntry", () => {
  it("UPDATEs only the fields that were provided, sets status='pending_file'", async () => {
    const mutators = createMutators();
    const { tx, memoryUpdates } = makeMockTx();
    await mutators.updateMemoryEntry(tx, {
      id: "my-note",
      title: "New Title",
      ts: 5,
    } as UpdateMemoryEntryArgs);
    expect(memoryUpdates).toHaveLength(1);
    const u = memoryUpdates[0]!;
    expect(u).toMatchObject({
      id: "my-note",
      title: "New Title",
      updated_at: 5,
      status: "pending_file",
    });
    expect("content" in u).toBe(false);
    expect("tags_json" in u).toBe(false);
  });

  it("always advances updated_at AND sets status='pending_file'", async () => {
    const mutators = createMutators();
    const { tx, memoryUpdates } = makeMockTx();
    await mutators.updateMemoryEntry(tx, { id: "x", ts: 42 });
    expect(memoryUpdates[0]!.updated_at).toBe(42);
    expect(memoryUpdates[0]!.status).toBe("pending_file");
  });

  it("supports updating content + tags together", async () => {
    const mutators = createMutators();
    const { tx, memoryUpdates } = makeMockTx();
    await mutators.updateMemoryEntry(tx, {
      id: "x",
      content: "new body",
      tags: ["a", "b"],
      ts: 1,
    });
    expect(memoryUpdates[0]!.content).toBe("new body");
    expect(memoryUpdates[0]!.tags_json).toEqual(["a", "b"]);
  });
});

describe("deleteMemoryEntry", () => {
  it("UPDATEs to status='pending_delete' (soft-delete; daemon trashes the file)", async () => {
    const mutators = createMutators();
    const { tx, memoryUpdates } = makeMockTx();
    await mutators.deleteMemoryEntry(tx, {
      id: "to-delete",
      ts: 7,
    } as DeleteMemoryEntryArgs);
    expect(memoryUpdates).toEqual([
      { id: "to-delete", updated_at: 7, status: "pending_delete" },
    ]);
  });

  it("is idempotent — re-running with same args produces identical writes", async () => {
    const mutators = createMutators();
    const { tx, memoryUpdates } = makeMockTx();
    const args: DeleteMemoryEntryArgs = { id: "x", ts: 1 };
    await mutators.deleteMemoryEntry(tx, args);
    await mutators.deleteMemoryEntry(tx, args);
    expect(memoryUpdates).toHaveLength(2);
    expect(memoryUpdates[0]).toEqual(memoryUpdates[1]);
  });

  it("does NOT touch tags / content / title (only status + updated_at)", async () => {
    const mutators = createMutators();
    const { tx, memoryUpdates } = makeMockTx();
    await mutators.deleteMemoryEntry(tx, { id: "x", ts: 1 });
    const u = memoryUpdates[0] as Record<string, unknown>;
    expect("content" in u).toBe(false);
    expect("title" in u).toBe(false);
    expect("tags_json" in u).toBe(false);
  });
});

describe("createSchedule", () => {
  it("INSERTs schedules at status='pending_register'", async () => {
    const mutators = createMutators();
    const { tx, scheduleInserts } = makeMockTx();
    const args: CreateScheduleArgs = {
      name: "daily-summary",
      cron: "0 8 * * *",
      taskPrompt: "Summarize yesterday",
      ts: 1_700_000_000_000,
    };
    await mutators.createSchedule(tx, args);
    expect(scheduleInserts).toHaveLength(1);
    expect(scheduleInserts[0]).toMatchObject({
      name: "daily-summary",
      cron: "0 8 * * *",
      task_prompt: "Summarize yesterday",
      paused: false,
      status: "pending_register",
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    });
  });

  it("leaves next_run_at NULL — the daemon LISTEN handler computes it", async () => {
    // Critical contract: nextRunAt is computed server-side after
    // the mutator UPDATE. If the client guessed it, multi-device
    // clocks would disagree.
    const mutators = createMutators();
    const { tx, scheduleInserts } = makeMockTx();
    await mutators.createSchedule(tx, {
      name: "x",
      cron: "*/5 * * * *",
      taskPrompt: "X",
      ts: 1,
    });
    expect(scheduleInserts[0]!.next_run_at).toBeNull();
    expect(scheduleInserts[0]!.last_run_at).toBeNull();
    expect(scheduleInserts[0]!.last_run_id).toBeNull();
  });

  it("status is always 'pending_register' on insert (never 'active')", async () => {
    const mutators = createMutators();
    const { tx, scheduleInserts } = makeMockTx();
    await mutators.createSchedule(tx, {
      name: "y",
      taskPrompt: "Y",
      ts: 1,
    });
    expect(scheduleInserts[0]!.status).toBe("pending_register");
  });

  it("supports runAt (one-shot schedules) alongside cron", async () => {
    const mutators = createMutators();
    const { tx, scheduleInserts } = makeMockTx();
    await mutators.createSchedule(tx, {
      name: "one-shot",
      runAt: "2026-12-25T08:00:00Z",
      taskPrompt: "merry christmas",
      ts: 1,
    });
    expect(scheduleInserts[0]!.run_at).toBe("2026-12-25T08:00:00Z");
  });
});

describe("updateSchedule", () => {
  it("UPDATEs with status='reload_requested' + advanced updated_at", async () => {
    const mutators = createMutators();
    const { tx, scheduleUpdates } = makeMockTx();
    await mutators.updateSchedule(tx, {
      name: "daily",
      cron: "0 9 * * *",
      ts: 42,
    } as UpdateScheduleArgs);
    expect(scheduleUpdates).toEqual([
      {
        name: "daily",
        cron: "0 9 * * *",
        updated_at: 42,
        status: "reload_requested",
      },
    ]);
  });

  it("preserves omitted fields (only patches what was provided)", async () => {
    const mutators = createMutators();
    const { tx, scheduleUpdates } = makeMockTx();
    await mutators.updateSchedule(tx, {
      name: "daily",
      paused: true,
      ts: 1,
    });
    const u = scheduleUpdates[0]!;
    expect(u.name).toBe("daily");
    expect(u.paused).toBe(true);
    expect("cron" in u).toBe(false);
    expect("run_at" in u).toBe(false);
    expect("task_prompt" in u).toBe(false);
  });

  it("supports clearing cron / runAt to null (transition from cron to runAt or vice versa)", async () => {
    const mutators = createMutators();
    const { tx, scheduleUpdates } = makeMockTx();
    await mutators.updateSchedule(tx, {
      name: "x",
      cron: null,
      runAt: "2026-12-25T08:00:00Z",
      ts: 1,
    });
    expect(scheduleUpdates[0]!.cron).toBeNull();
    expect(scheduleUpdates[0]!.run_at).toBe("2026-12-25T08:00:00Z");
  });
});

describe("deleteSchedule", () => {
  it("UPDATEs to status='deleted' (soft-delete; daemon cleans up registry stub)", async () => {
    const mutators = createMutators();
    const { tx, scheduleUpdates } = makeMockTx();
    await mutators.deleteSchedule(tx, {
      name: "to-delete",
      ts: 7,
    } as DeleteScheduleArgs);
    expect(scheduleUpdates).toEqual([
      { name: "to-delete", updated_at: 7, status: "deleted" },
    ]);
  });

  it("is idempotent — re-running produces identical writes", async () => {
    const mutators = createMutators();
    const { tx, scheduleUpdates } = makeMockTx();
    const args: DeleteScheduleArgs = { name: "x", ts: 1 };
    await mutators.deleteSchedule(tx, args);
    await mutators.deleteSchedule(tx, args);
    expect(scheduleUpdates).toHaveLength(2);
    expect(scheduleUpdates[0]).toEqual(scheduleUpdates[1]);
  });

  it("does NOT touch cron, runAt, taskPrompt, paused (only status + updated_at)", async () => {
    const mutators = createMutators();
    const { tx, scheduleUpdates } = makeMockTx();
    await mutators.deleteSchedule(tx, { name: "x", ts: 1 });
    const u = scheduleUpdates[0] as Record<string, unknown>;
    expect("cron" in u).toBe(false);
    expect("run_at" in u).toBe(false);
    expect("task_prompt" in u).toBe(false);
    expect("paused" in u).toBe(false);
  });
});

describe("installApp", () => {
  it("INSERTs apps stub at status='pending_install' with placeholder name/version/manifest", async () => {
    const mutators = createMutators();
    const { tx, appInserts } = makeMockTx();
    const args: InstallAppArgs = {
      id: "my-app",
      folderPath: "/Users/x/.friday/apps/my-app",
      ts: 1_700_000_000_000,
    };
    await mutators.installApp(tx, args);
    expect(appInserts).toEqual([
      {
        id: "my-app",
        name: "",
        version: "0.0.0",
        manifest_version: 0,
        folder_path: "/Users/x/.friday/apps/my-app",
        manifest_json: {},
        status: "pending_install",
        installed_at: 1_700_000_000_000,
        upgraded_at: null,
        meta_json: null,
      },
    ]);
  });

  it("status is always 'pending_install' on insert (daemon flips to 'installed' after manifest read)", async () => {
    const mutators = createMutators();
    const { tx, appInserts } = makeMockTx();
    await mutators.installApp(tx, {
      id: "x",
      folderPath: "/x",
      ts: 1,
    });
    expect(appInserts[0]!.status).toBe("pending_install");
  });

  it("stub name/version/manifest never user-visible — dashboard query filters pending_install", async () => {
    // The placeholder values are present in the row briefly. The
    // dashboard's `#bindApps` query filters status='pending_install'
    // so they're never rendered. This test pins the placeholder
    // shape so a future refactor doesn't accidentally show
    // garbage data through.
    const mutators = createMutators();
    const { tx, appInserts } = makeMockTx();
    await mutators.installApp(tx, { id: "x", folderPath: "/x", ts: 1 });
    expect(appInserts[0]!.name).toBe("");
    expect(appInserts[0]!.version).toBe("0.0.0");
    expect(appInserts[0]!.manifest_version).toBe(0);
    expect(appInserts[0]!.manifest_json).toEqual({});
  });
});

describe("uninstallApp", () => {
  it("UPDATEs to status='uninstall_requested' — daemon does the actual uninstall", async () => {
    const mutators = createMutators();
    const { tx, appUpdates } = makeMockTx();
    await mutators.uninstallApp(tx, {
      id: "my-app",
      ts: 5,
    } as UninstallAppArgs);
    expect(appUpdates).toEqual([
      { id: "my-app", status: "uninstall_requested" },
    ]);
  });

  it("is idempotent — re-running with same args produces identical writes", async () => {
    const mutators = createMutators();
    const { tx, appUpdates } = makeMockTx();
    const args: UninstallAppArgs = { id: "x", ts: 1 };
    await mutators.uninstallApp(tx, args);
    await mutators.uninstallApp(tx, args);
    expect(appUpdates).toHaveLength(2);
    expect(appUpdates[0]).toEqual(appUpdates[1]);
  });

  it("touches only id + status — daemon owns all other field writes", async () => {
    const mutators = createMutators();
    const { tx, appUpdates } = makeMockTx();
    await mutators.uninstallApp(tx, { id: "x", ts: 1 });
    const u = appUpdates[0] as Record<string, unknown>;
    expect(Object.keys(u).sort()).toEqual(["id", "status"]);
  });
});

describe("reloadApp", () => {
  it("UPDATEs to status='reload_requested'", async () => {
    const mutators = createMutators();
    const { tx, appUpdates } = makeMockTx();
    await mutators.reloadApp(tx, {
      id: "my-app",
      ts: 5,
    } as ReloadAppArgs);
    expect(appUpdates).toEqual([
      { id: "my-app", status: "reload_requested" },
    ]);
  });

  it("is idempotent", async () => {
    const mutators = createMutators();
    const { tx, appUpdates } = makeMockTx();
    const args: ReloadAppArgs = { id: "x", ts: 1 };
    await mutators.reloadApp(tx, args);
    await mutators.reloadApp(tx, args);
    expect(appUpdates).toHaveLength(2);
    expect(appUpdates[0]).toEqual(appUpdates[1]);
  });
});

describe("archiveAgent", () => {
  it("UPDATEs status='archive_requested' + records archive_reason", async () => {
    const mutators = createMutators();
    const { tx, agentUpdates } = makeMockTx();
    const args: ArchiveAgentArgs = {
      name: "builder-xyz",
      reason: "completed",
      ts: 1_700_000_000_000,
    };
    await mutators.archiveAgent(tx, args);
    expect(agentUpdates).toEqual([
      {
        name: "builder-xyz",
        status: "archive_requested",
        archive_reason: "completed",
        updated_at: 1_700_000_000_000,
      },
    ]);
  });

  it("supports all four reason values", async () => {
    const mutators = createMutators();
    const { tx, agentUpdates } = makeMockTx();
    for (const reason of [
      "completed",
      "abandoned",
      "failed",
      "refork",
    ] as const) {
      await mutators.archiveAgent(tx, {
        name: `agent-${reason}`,
        reason,
        ts: 1,
      });
    }
    expect(agentUpdates.map((u) => u.archive_reason).sort()).toEqual(
      ["abandoned", "completed", "failed", "refork"].sort(),
    );
  });

  it("is idempotent — re-archiving with same args produces identical writes", async () => {
    const mutators = createMutators();
    const { tx, agentUpdates } = makeMockTx();
    const args: ArchiveAgentArgs = {
      name: "x",
      reason: "abandoned",
      ts: 1,
    };
    await mutators.archiveAgent(tx, args);
    await mutators.archiveAgent(tx, args);
    expect(agentUpdates).toHaveLength(2);
    expect(agentUpdates[0]).toEqual(agentUpdates[1]);
  });

  it("touches only name + status + archive_reason + updated_at — daemon owns everything else", async () => {
    const mutators = createMutators();
    const { tx, agentUpdates } = makeMockTx();
    await mutators.archiveAgent(tx, {
      name: "x",
      reason: "abandoned",
      ts: 1,
    });
    const u = agentUpdates[0] as Record<string, unknown>;
    expect(Object.keys(u).sort()).toEqual(
      ["archive_reason", "name", "status", "updated_at"].sort(),
    );
  });
});

describe("cancelQueued", () => {
  it("UPDATEs blocks.status to 'cancel_requested' keyed by bigserial id", async () => {
    const mutators = createMutators();
    const { tx, blocksUpdates } = makeMockTx();
    const args: CancelQueuedArgs = {
      id: 4242,
      ts: 1_700_000_000_000,
    };
    await mutators.cancelQueued(tx, args);
    expect(blocksUpdates).toEqual([{ id: 4242, status: "cancel_requested" }]);
  });

  it("is idempotent — re-running with same args produces identical writes", async () => {
    // Plan §5: every mutator idempotent on row PK. A second invocation
    // with the same args reflects the LISTEN-path winning the race
    // (row already DELETEd at the server) — the mutator's write set
    // stays identical.
    const mutators = createMutators();
    const { tx, blocksUpdates } = makeMockTx();
    const args: CancelQueuedArgs = { id: 1, ts: 1 };
    await mutators.cancelQueued(tx, args);
    await mutators.cancelQueued(tx, args);
    expect(blocksUpdates).toHaveLength(2);
    expect(blocksUpdates[0]).toEqual(blocksUpdates[1]);
  });

  it("touches only id + status — daemon owns content_json / turn_id / agent_name", async () => {
    // Pre/post-condition contract: the daemon's LISTEN handler reads
    // agent_name, turn_id, content_json from the row BEFORE the
    // DELETE. The mutator MUST NOT clobber them. Verify the write
    // patch contains exactly two keys.
    const mutators = createMutators();
    const { tx, blocksUpdates } = makeMockTx();
    await mutators.cancelQueued(tx, { id: 99, ts: 1 });
    const u = blocksUpdates[0] as Record<string, unknown>;
    expect(Object.keys(u).sort()).toEqual(["id", "status"].sort());
  });

  it("does not write the args.ts field — the row's ts is daemon-owned (block timestamp)", async () => {
    // The mutator interface includes `ts` for symmetry with other
    // mutators (and for diagnostic logging at the Zero server-side
    // PushProcessor layer), but the row's `ts` is the block's
    // arrival timestamp set by `recordUserBlock` and must not be
    // clobbered to a cancel timestamp.
    const mutators = createMutators();
    const { tx, blocksUpdates } = makeMockTx();
    await mutators.cancelQueued(tx, { id: 1, ts: 9_999_999_999_999 });
    const u = blocksUpdates[0] as Record<string, unknown>;
    expect(u.ts).toBeUndefined();
  });
});
