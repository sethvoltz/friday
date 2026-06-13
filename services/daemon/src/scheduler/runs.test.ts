/**
 * ADR-024 — schedule_runs history writer.
 *
 * The schedule_runs table was declared (db/schema.ts) and published for
 * replication (pg-provision SYNC_TABLES) but nothing ever wrote to it, so the
 * dashboard had no run history. fireSchedule now opens a `running` row per
 * fire and transitions it to a terminal status:
 *
 *   AC1 — a reminder fire (synchronous) writes exactly one row that ends
 *         `complete`, with completed_at stamped and no error.
 *   AC2 — when the fire path throws, the row ends `error` carrying the message.
 *   AC3 — an agent-run fire opens the row as `running` (the worker is
 *         fire-and-forget; the terminal transition happens later in onExit).
 *   AC4 — closeScheduleRun (used by the agent-run worker's onExit) transitions
 *         a row to complete/error, and is a no-op for a null id.
 *
 * Run end-to-end against a real scratch Postgres (createTestDb) so the
 * schedule_runs rows, the status check constraint, and the bigserial id handle
 * are all real.
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";

// spawnScheduledRun is mocked so the agent-run branch doesn't fork a real
// worker. The mock is hoisted above the dynamic import of ./scheduler.js.
const spawnScheduledRun = vi.fn(async (..._args: unknown[]) => {});
vi.mock("./spawn.js", () => ({ spawnScheduledRun }));

let handle: TestDbHandle;
let fireSchedule: (typeof import("./scheduler.js"))["fireSchedule"];
let closeScheduleRun: (typeof import("./runs.js"))["closeScheduleRun"];
let openScheduleRun: (typeof import("./runs.js"))["openScheduleRun"];

beforeAll(async () => {
  handle = await createTestDb({ label: "schedule-runs" });
  ({ fireSchedule } = await import("./scheduler.js"));
  ({ closeScheduleRun, openScheduleRun } = await import("./runs.js"));
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  spawnScheduledRun.mockReset();
  spawnScheduledRun.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedRow(row: {
  name: string;
  kind: "agent-run" | "reminder";
  cron?: string | null;
  runAt?: string | null;
  taskPrompt: string;
  deliveryJson?: Record<string, unknown> | null;
  nextRunAt: Date | null;
}): Promise<typeof schema.schedules.$inferSelect> {
  const now = new Date();
  await getDb()
    .insert(schema.schedules)
    .values({
      name: row.name,
      cron: row.cron ?? null,
      runAt: row.runAt ?? null,
      taskPrompt: row.taskPrompt,
      paused: false,
      status: "active",
      kind: row.kind,
      deliveryJson: row.deliveryJson ?? null,
      nextRunAt: row.nextRunAt,
      lastRunAt: null,
      lastRunId: null,
      metaJson: null,
      createdAt: now,
      updatedAt: now,
    });
  const rows = await getDb()
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.name, row.name))
    .limit(1);
  return rows[0]!;
}

async function runsFor(name: string): Promise<(typeof schema.scheduleRuns.$inferSelect)[]> {
  return await getDb()
    .select()
    .from(schema.scheduleRuns)
    .where(eq(schema.scheduleRuns.scheduleName, name))
    .orderBy(asc(schema.scheduleRuns.id));
}

describe("ADR-024 fireSchedule writes schedule_runs history", () => {
  it("AC1: a reminder fire writes exactly one row that ends 'complete' with completed_at and no error", async () => {
    const row = await seedRow({
      name: "thaw-chicken",
      kind: "reminder",
      runAt: new Date(Date.now() - 1000).toISOString(),
      taskPrompt: "Thaw the chicken",
      deliveryJson: { channel: "chat", title: "Thaw the chicken" },
      nextRunAt: new Date(Date.now() - 1000),
    });

    await fireSchedule(row);

    const runs = await runsFor("thaw-chicken");
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("complete");
    expect(runs[0]!.firedAt).toBeInstanceOf(Date);
    expect(runs[0]!.completedAt).toBeInstanceOf(Date);
    expect(runs[0]!.error).toBeNull();
  });

  it("AC2: when the fire path throws, the row ends 'error' carrying the message", async () => {
    spawnScheduledRun.mockRejectedValueOnce(new Error("boom: worker spawn failed"));
    const row = await seedRow({
      name: "meta-daily",
      kind: "agent-run",
      cron: "0 4 * * *",
      taskPrompt: "run the meta agent",
      nextRunAt: new Date(Date.now() - 1000),
    });

    await fireSchedule(row);

    const runs = await runsFor("meta-daily");
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("error");
    expect(runs[0]!.completedAt).toBeInstanceOf(Date);
    expect(runs[0]!.error).toContain("boom: worker spawn failed");
  });

  it("AC3: an agent-run fire opens the row as 'running' and hands its id to spawnScheduledRun", async () => {
    const row = await seedRow({
      name: "nightly",
      kind: "agent-run",
      cron: "0 2 * * *",
      taskPrompt: "do nightly work",
      nextRunAt: new Date(Date.now() - 1000),
    });

    await fireSchedule(row);

    const runs = await runsFor("nightly");
    expect(runs.length).toBe(1);
    // The worker is fire-and-forget; the row stays 'running' until onExit.
    expect(runs[0]!.status).toBe("running");
    expect(runs[0]!.completedAt).toBeNull();

    // The opened row's id is threaded into spawnScheduledRun as the 3rd arg so
    // the worker's onExit can close it.
    expect(spawnScheduledRun).toHaveBeenCalledTimes(1);
    const [, , passedRunRowId] = spawnScheduledRun.mock.calls[0]!;
    expect(passedRunRowId).toBe(runs[0]!.id);
  });
});

describe("ADR-024 closeScheduleRun (agent-run worker onExit transition)", () => {
  it("AC4: transitions an open row to 'complete'", async () => {
    const id = await openScheduleRun("worker-done");
    expect(id).not.toBeNull();

    await closeScheduleRun(id, "complete");

    const runs = await runsFor("worker-done");
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("complete");
    expect(runs[0]!.completedAt).toBeInstanceOf(Date);
    expect(runs[0]!.error).toBeNull();
  });

  it("AC4: transitions an open row to 'error' with a message", async () => {
    const id = await openScheduleRun("worker-failed");
    await closeScheduleRun(id, "error", "worker exited with error");

    const runs = await runsFor("worker-failed");
    expect(runs[0]!.status).toBe("error");
    expect(runs[0]!.error).toBe("worker exited with error");
  });

  it("AC4: is a no-op for a null id (open insert failed)", async () => {
    await expect(closeScheduleRun(null, "complete")).resolves.toBeUndefined();
  });
});
