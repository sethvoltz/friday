/**
 * FRI-143 — reminder fire path. A `kind='reminder'` schedule row fires as a
 * user-facing chat block via `deliverReminder` and NEVER spawns a worker or
 * wakes any agent. Exercised end-to-end against a real scratch Postgres
 * (createTestDb) so the delivered `blocks` row, the post-fire `nextRunAt`
 * mutation, and the tick's `nextRunAt !== null` filter are all real.
 *
 *   AC1/AC2 — fire branches to deliverReminder (reminder) vs spawnScheduledRun
 *             (agent-run); the wrong path is provably not taken.
 *   AC3     — delivered block shape (role/kind/source/agentName/status + text).
 *   AC4     — one-shot reminder fires exactly once across two ticks (nextRunAt
 *             nulled on fire); recurring reminder advances to the next cron
 *             instant; one-shot agent-run is NOT nulled; nextRunAfterFire unit.
 *   AC9     — no agent is woken (wakeAgent/wakeAgentCritical/dispatchTurn not
 *             called) and no `agent_message` SSE is published for the reminder.
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, getDb, nextRun, schema, type TestDbHandle } from "@friday/shared";

// `spawnScheduledRun` is mocked so AC1/AC2 can assert which fire branch ran
// without forking a real worker. The mock is hoisted above the dynamic import
// of `./scheduler.js` below.
const spawnScheduledRun = vi.fn(async () => {});
vi.mock("./spawn.js", () => ({ spawnScheduledRun }));

let handle: TestDbHandle;
let fireSchedule: (typeof import("./scheduler.js"))["fireSchedule"];
let nextRunAfterFire: (typeof import("./scheduler.js"))["nextRunAfterFire"];
let upsertSchedule: (typeof import("./scheduler.js"))["upsertSchedule"];
let triggerSchedule: (typeof import("./scheduler.js"))["triggerSchedule"];
let selectDueSchedules: (typeof import("./scheduler.js"))["selectDueSchedules"];
let processPendingScheduleRow: (typeof import("./listener.js"))["processPendingScheduleRow"];
let eventBus: (typeof import("../events/bus.js"))["eventBus"];
let lifecycle: typeof import("../agent/lifecycle.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "reminder-fire" });
  ({ fireSchedule, nextRunAfterFire, upsertSchedule, triggerSchedule, selectDueSchedules } =
    await import("./scheduler.js"));
  ({ processPendingScheduleRow } = await import("./listener.js"));
  ({ eventBus } = await import("../events/bus.js"));
  lifecycle = await import("../agent/lifecycle.js");
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  spawnScheduledRun.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Insert a schedule row directly (bypassing upsertSchedule's stub-agent
 *  registration) so a fire test can seed an arbitrary kind/cron/runAt/nextRunAt
 *  without coupling to the registry. */
async function seedRow(row: {
  name: string;
  kind: "agent-run" | "reminder";
  cron?: string | null;
  runAt?: string | null;
  taskPrompt: string;
  deliveryJson?: Record<string, unknown> | null;
  nextRunAt: Date | null;
  status?: string;
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
      status: row.status ?? "active",
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

async function reminderBlocks(): Promise<(typeof schema.blocks.$inferSelect)[]> {
  return await getDb().select().from(schema.blocks).where(eq(schema.blocks.source, "reminder"));
}

describe("FRI-143 fireSchedule — reminder vs agent-run branch (AC1/AC2)", () => {
  it("AC1: a kind='reminder' due row delivers ONE source='reminder' block to 'friday' and does NOT call spawnScheduledRun", async () => {
    const row = await seedRow({
      name: "thaw-chicken",
      kind: "reminder",
      runAt: new Date(Date.now() - 1000).toISOString(),
      taskPrompt: "Thaw the chicken",
      deliveryJson: { channel: "chat", title: "Thaw the chicken" },
      nextRunAt: new Date(Date.now() - 1000),
    });

    await fireSchedule(row);

    const blocks = await reminderBlocks();
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.agentName).toBe("friday");
    expect(spawnScheduledRun).not.toHaveBeenCalled();
  });

  it("AC2: a kind='agent-run' due row calls spawnScheduledRun exactly once and writes NO source='reminder' block", async () => {
    const row = await seedRow({
      name: "meta-daily",
      kind: "agent-run",
      cron: "0 4 * * *",
      taskPrompt: "run the meta agent",
      nextRunAt: new Date(Date.now() - 1000),
    });

    await fireSchedule(row);

    expect(spawnScheduledRun).toHaveBeenCalledTimes(1);
    // ADR-024: fireSchedule now threads the opened schedule_runs row id as a
    // third arg so the worker's onExit can close it.
    expect(spawnScheduledRun).toHaveBeenCalledWith(
      expect.objectContaining({ name: "meta-daily", kind: "agent-run" }),
      expect.any(String),
      expect.any(Number),
    );
    const blocks = await reminderBlocks();
    expect(blocks.length).toBe(0);
  });
});

describe("FRI-143 delivered reminder block shape (AC3)", () => {
  it("writes a role:'user', kind:'text', source:'reminder', status:'complete' block in the orchestrator chat whose text contains the title", async () => {
    const row = await seedRow({
      name: "standup",
      kind: "reminder",
      runAt: new Date(Date.now() - 1000).toISOString(),
      taskPrompt: "fallback prompt",
      deliveryJson: { channel: "chat", title: "Daily standup", body: "join the call" },
      nextRunAt: new Date(Date.now() - 1000),
    });

    await fireSchedule(row);

    const blocks = await reminderBlocks();
    expect(blocks.length).toBe(1);
    const b = blocks[0]!;
    expect(b).toMatchObject({
      role: "user",
      kind: "text",
      source: "reminder",
      agentName: "friday",
      status: "complete",
    });
    expect((b.contentJson as { text: string }).text).toContain("Daily standup");
    // body is appended after the title.
    expect((b.contentJson as { text: string }).text).toContain("join the call");
  });
});

describe("FRI-143 no agent woken, no agent_message SSE (AC9)", () => {
  it("does NOT call wakeAgent / wakeAgentCritical / dispatchTurn / spawnScheduledRun when a reminder fires", async () => {
    const wakeAgent = vi.spyOn(lifecycle, "wakeAgent");
    const wakeAgentCritical = vi.spyOn(lifecycle, "wakeAgentCritical");
    const dispatchTurn = vi.spyOn(lifecycle, "dispatchTurn");

    const row = await seedRow({
      name: "quiet-nudge",
      kind: "reminder",
      runAt: new Date(Date.now() - 1000).toISOString(),
      taskPrompt: "nudge",
      deliveryJson: { channel: "chat", title: "nudge" },
      nextRunAt: new Date(Date.now() - 1000),
    });

    await fireSchedule(row);

    expect(wakeAgent).not.toHaveBeenCalled();
    expect(wakeAgentCritical).not.toHaveBeenCalled();
    expect(dispatchTurn).not.toHaveBeenCalled();
    expect(spawnScheduledRun).not.toHaveBeenCalled();
  });

  it("publishes a block_complete event for the reminder but NO agent_message event (role:'user' is suppressed by maybeEmitAgentMessage)", async () => {
    const publish = vi.spyOn(eventBus, "publish");

    const row = await seedRow({
      name: "silent",
      kind: "reminder",
      runAt: new Date(Date.now() - 1000).toISOString(),
      taskPrompt: "silent",
      deliveryJson: { channel: "chat", title: "silent" },
      nextRunAt: new Date(Date.now() - 1000),
    });

    await fireSchedule(row);

    const published = publish.mock.calls.map((c) => c[0]);
    const reminderEvents = published.filter(
      (e) => "source" in e && (e as { source?: string }).source === "reminder",
    );
    expect(reminderEvents.length).toBe(1);
    expect(reminderEvents[0]!.type).toBe("block_complete");
    expect(published.some((e) => e.type === "agent_message")).toBe(false);
  });
});

describe("FRI-143 exactly-once one-shot + recurring advance (AC4)", () => {
  it("AC4a: a one-shot reminder has nextRunAt nulled on fire, so the tick filter drops it and it is delivered exactly once across two ticks", async () => {
    const runAtIso = new Date(Date.now() - 1000).toISOString();
    await seedRow({
      name: "once",
      kind: "reminder",
      runAt: runAtIso,
      taskPrompt: "once",
      deliveryJson: { channel: "chat", title: "once" },
      nextRunAt: new Date(runAtIso),
    });

    // First fire (simulate the tick selecting the due row).
    const due1 = await getDb()
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.name, "once"))
      .limit(1);
    await fireSchedule(due1[0]!);

    const afterFirst = await getDb()
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.name, "once"))
      .limit(1);
    expect(afterFirst[0]!.nextRunAt).toBeNull();

    // Second tick: re-select using the REAL exported tick predicate
    // (selectDueSchedules), NOT a hand-rolled copy — so a regression dropping
    // `nextRunAt !== null` from production's filter is actually caught here.
    const now = new Date();
    const all = await getDb().select().from(schema.schedules);
    const due2 = selectDueSchedules(all, now);
    expect(due2.some((r) => r.name === "once")).toBe(false);
    expect(due2.length).toBe(0);
    for (const r of due2) await fireSchedule(r);

    const blocks = await reminderBlocks();
    expect(blocks.length).toBe(1);
  });

  it("AC4b: a recurring (cron) reminder advances nextRunAt to the exact next cron instant on fire", async () => {
    const cron = "0 4 * * *";
    const row = await seedRow({
      name: "daily-nudge",
      kind: "reminder",
      cron,
      taskPrompt: "daily nudge",
      deliveryJson: { channel: "chat", title: "daily nudge" },
      nextRunAt: new Date(Date.now() - 1000),
    });

    const before = new Date();
    await fireSchedule(row);
    const after = await getDb()
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.name, "daily-nudge"))
      .limit(1);

    // host-TZ next cron instant (no FRI-98 tz). Recompute the expected value
    // bounded by the fire window so we don't flake on the second boundary.
    const expected = nextRun(cron, before)!;
    expect(after[0]!.nextRunAt).not.toBeNull();
    // The persisted value must be exactly a cron instant at or after the fire.
    const persisted = after[0]!.nextRunAt!;
    const expectedAfter = nextRun(cron, new Date())!;
    expect([expected.getTime(), expectedAfter.getTime()]).toContain(persisted.getTime());
  });

  it("AC4: a one-shot AGENT-RUN row is NOT nulled on fire (pre-existing behavior unchanged)", async () => {
    const runAtIso = new Date(Date.now() - 1000).toISOString();
    const row = await seedRow({
      name: "oneshot-agent",
      kind: "agent-run",
      runAt: runAtIso,
      taskPrompt: "do work once",
      nextRunAt: new Date(runAtIso),
    });

    await fireSchedule(row);

    const after = await getDb()
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.name, "oneshot-agent"))
      .limit(1);
    // computeNext(runAt) returns the (past) instant — not null. The agent-run
    // one-shot keeps its old non-null behavior; only reminders are nulled.
    expect(after[0]!.nextRunAt).not.toBeNull();
    expect(after[0]!.nextRunAt!.getTime()).toBe(Date.parse(runAtIso));
  });

  it("AC4: nextRunAfterFire returns null for a one-shot reminder and a Date for a cron reminder / agent-run row", async () => {
    const oneShotReminder = {
      name: "r1",
      cron: null,
      runAt: new Date(Date.now() - 1000).toISOString(),
      taskPrompt: "x",
      kind: "reminder",
    } as typeof schema.schedules.$inferSelect;
    expect(nextRunAfterFire(oneShotReminder)).toBeNull();

    const cronReminder = {
      name: "r2",
      cron: "0 4 * * *",
      runAt: null,
      taskPrompt: "x",
      kind: "reminder",
    } as typeof schema.schedules.$inferSelect;
    expect(nextRunAfterFire(cronReminder)).toBeInstanceOf(Date);

    const oneShotAgentRun = {
      name: "r3",
      cron: null,
      runAt: new Date(Date.now() - 1000).toISOString(),
      taskPrompt: "x",
      kind: "agent-run",
    } as typeof schema.schedules.$inferSelect;
    expect(nextRunAfterFire(oneShotAgentRun)).toBeInstanceOf(Date);
  });

  it("AC4 (gap fix): manually triggering a one-shot reminder via triggerSchedule leaves nextRunAt null (does not re-arm the tick)", async () => {
    const runAtIso = new Date(Date.now() - 1000).toISOString();
    await seedRow({
      name: "manual-once",
      kind: "reminder",
      runAt: runAtIso,
      taskPrompt: "manual once",
      deliveryJson: { channel: "chat", title: "manual once" },
      nextRunAt: new Date(runAtIso),
    });

    const runId = await triggerSchedule("manual-once");
    expect(runId).not.toBeNull();

    const after = await getDb()
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.name, "manual-once"))
      .limit(1);
    expect(after[0]!.nextRunAt).toBeNull();

    const blocks = await reminderBlocks();
    expect(blocks.length).toBe(1);
  });

  it("AC4 (gap fix, LISTEN path): a one-shot reminder fired via processPendingScheduleRow (status='trigger_requested') keeps nextRunAt null — the listener tail uses nextRunAfterFire, not computeNext", async () => {
    // Directly exercises listener.ts's trigger_requested branch (the actual
    // gap-fix site). triggerSchedule above covers the scheduler path; this
    // covers the listener's separate post-fire UPDATE. Reverting that line to
    // computeNext(row) would re-arm nextRunAt to the past runAt and fail here.
    const runAtIso = new Date(Date.now() - 1000).toISOString();
    await seedRow({
      name: "listener-once",
      kind: "reminder",
      runAt: runAtIso,
      taskPrompt: "listener once",
      deliveryJson: { channel: "chat", title: "listener once" },
      nextRunAt: new Date(runAtIso),
      status: "trigger_requested",
    });

    await processPendingScheduleRow("listener-once");

    const after = await getDb()
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.name, "listener-once"))
      .limit(1);
    expect(after[0]!.nextRunAt).toBeNull();
    expect(after[0]!.status).toBe("active");

    const blocks = await reminderBlocks();
    expect(blocks.length).toBe(1);
  });
});

describe("FRI-143 upsertSchedule reminder write path (AC6)", () => {
  it("writes a kind='reminder' row with deliveryJson and status='active', and registers NO stub agent for it", async () => {
    const registry = await import("../agent/registry.js");
    const runAt = new Date(Date.now() + 60_000).toISOString();
    await upsertSchedule({
      name: "remind-me",
      runAt,
      kind: "reminder",
      taskPrompt: "Remind me",
      deliveryJson: { channel: "chat", title: "Remind me", body: "the thing" },
    });

    const rows = await getDb()
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.name, "remind-me"))
      .limit(1);
    expect(rows[0]).toMatchObject({
      kind: "reminder",
      deliveryJson: { title: "Remind me" },
    });
    expect(rows[0]!.status).toBe("active");

    // Reminder rows still get a computed nextRunAt so the 30s tick picks them
    // up when due — a regression nulling it inside upsertSchedule must fail here.
    expect(rows[0]!.nextRunAt).not.toBeNull();
    expect(rows[0]!.nextRunAt!.getTime()).toBe(Date.parse(runAt));

    // The FRI-76 eager stub-agent registration is skipped for reminders.
    expect(await registry.getAgent("remind-me")).toBeNull();
  });
});
