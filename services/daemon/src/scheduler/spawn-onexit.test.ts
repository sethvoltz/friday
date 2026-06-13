/**
 * ADR-024 — the ASYNC agent-run terminal transition (the real close path).
 *
 * `fireSchedule` opens a `running` schedule_runs row and, for an agent-run,
 * hands its id to `spawnScheduledRun`, which is fire-and-forget. The row's
 * terminal status is written LATER, from the worker's `onExit` callback
 * (`spawn.ts`) — NOT from `fireSchedule`'s try/catch (that only catches a fire
 * that fails to even dispatch, which never happens in production). This suite
 * drives `spawn.ts`'s ACTUAL `onExit`/`onSpawnError` callbacks against a real
 * Postgres row and asserts the persisted terminal status:
 *
 *   - clean exit  (status "complete") → row closed `complete`, no error.
 *   - error exit  (status "error")    → row closed `error` with a message.
 *   - aborted exit (status "aborted") → row closed `error` with the distinct
 *                                       explanatory message "aborted" (NOT a
 *                                       bare failure with no reason).
 *   - spawn never started (onSpawnError) → row closed `error` with the throw.
 *
 * `dispatchTurn` is mocked to CAPTURE the SpawnTurnInput so the test can invoke
 * its real `onExit`/`onSpawnError` — i.e. we exercise spawn.ts's mapping logic,
 * not a hand-rolled copy.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, asc } from "drizzle-orm";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";
import type { SpawnTurnInput } from "../agent/lifecycle.js";

const dispatchTurn = vi.fn<(input: SpawnTurnInput) => void>();
vi.mock("../agent/lifecycle.js", () => ({ dispatchTurn }));
vi.mock("../prompts/build-dispatch-prompt.js", () => ({
  buildDispatchPrompt: vi.fn(async () => ({ systemPrompt: "sys-stub", body: "body-stub" })),
}));
vi.mock("../agent/registry.js", () => ({
  getAgent: vi.fn(async () => ({ name: "stub", type: "scheduled" })),
  registerAgent: vi.fn(async () => {}),
}));
vi.mock("../agent/block-injectors.js", () => ({ recordUserBlock: vi.fn(async () => {}) }));

let handle: TestDbHandle;
let spawnScheduledRun: (typeof import("./spawn.js"))["spawnScheduledRun"];
let openScheduleRun: (typeof import("./runs.js"))["openScheduleRun"];

beforeAll(async () => {
  handle = await createTestDb({ label: "spawn-onexit" });
  ({ spawnScheduledRun } = await import("./spawn.js"));
  ({ openScheduleRun } = await import("./runs.js"));
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  dispatchTurn.mockReset();
});

function fakeScheduleRow(name: string): typeof schema.schedules.$inferSelect {
  const now = new Date();
  return {
    name,
    cron: "0 2 * * *",
    runAt: null,
    taskPrompt: "do nightly work",
    paused: false,
    status: "active",
    kind: "agent-run",
    deliveryJson: null,
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    metaJson: null,
    createdAt: now,
    updatedAt: now,
  } as typeof schema.schedules.$inferSelect;
}

async function runRow(id: number): Promise<typeof schema.scheduleRuns.$inferSelect> {
  const rows = await getDb()
    .select()
    .from(schema.scheduleRuns)
    .where(eq(schema.scheduleRuns.id, id))
    .orderBy(asc(schema.scheduleRuns.id));
  return rows[0]!;
}

/** Run spawnScheduledRun with a real open run row and return the captured
 *  SpawnTurnInput so the test can drive the actual onExit/onSpawnError. */
async function spawnAndCapture(name: string): Promise<{ runRowId: number; input: SpawnTurnInput }> {
  const runRowId = (await openScheduleRun(name))!;
  expect(runRowId).not.toBeNull();
  await spawnScheduledRun(fakeScheduleRow(name), "r_test", runRowId);
  expect(dispatchTurn).toHaveBeenCalledTimes(1);
  const input = dispatchTurn.mock.calls[0]![0];
  return { runRowId, input };
}

describe("ADR-024 spawn.ts onExit closes the schedule_runs row (async terminal transition)", () => {
  it("clean exit (status 'complete') closes the row 'complete' with no error", async () => {
    const { runRowId, input } = await spawnAndCapture("nightly-ok");

    // Before onExit: still running.
    expect((await runRow(runRowId)).status).toBe("running");

    input.onExit!({ status: "complete", durationMs: 1234, completed: true });
    // onExit fires closeScheduleRun fire-and-forget; let the microtask settle.
    await vi.waitFor(async () => {
      expect((await runRow(runRowId)).status).toBe("complete");
    });

    const row = await runRow(runRowId);
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(row.error).toBeNull();
  });

  it("error exit (status 'error') closes the row 'error' with a message", async () => {
    const { runRowId, input } = await spawnAndCapture("nightly-fail");

    input.onExit!({ status: "error", durationMs: 5, completed: false });
    await vi.waitFor(async () => {
      expect((await runRow(runRowId)).status).toBe("error");
    });

    const row = await runRow(runRowId);
    expect(row.error).toBe("worker exited with error");
    expect(row.completedAt).toBeInstanceOf(Date);
  });

  it("aborted exit (status 'aborted') closes the row 'error' with the explanatory message 'aborted'", async () => {
    const { runRowId, input } = await spawnAndCapture("nightly-aborted");

    input.onExit!({ status: "aborted", durationMs: 5, completed: false });
    await vi.waitFor(async () => {
      expect((await runRow(runRowId)).status).toBe("error");
    });

    // LOW finding: an aborted run is NOT a bare failure-with-no-reason.
    expect((await runRow(runRowId)).error).toBe("aborted");
  });

  it("onSpawnError (fork never started) closes the row 'error' with the throw message", async () => {
    const { runRowId, input } = await spawnAndCapture("nightly-nofork");

    expect(input.onSpawnError).toBeTypeOf("function");
    input.onSpawnError!(new Error("ENOENT: spawn bash"));
    await vi.waitFor(async () => {
      expect((await runRow(runRowId)).status).toBe("error");
    });

    expect((await runRow(runRowId)).error).toContain("ENOENT");
  });
});
