/**
 * FRI-76: schedule_upsert eagerly registers a stub agent so mail to a
 * scheduled agent passes recipient validation before its first fire.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;
let registry: typeof import("../agent/registry.js");
let upsertSchedule: (typeof import("./scheduler.js"))["upsertSchedule"];
let deleteSchedule: (typeof import("./scheduler.js"))["deleteSchedule"];
let seedMetaAgents: (typeof import("./scheduler.js"))["seedMetaAgents"];
let getSchedule: (typeof import("./scheduler.js"))["getSchedule"];
let ScheduleNameCollisionError: (typeof import("./scheduler.js"))["ScheduleNameCollisionError"];
let META_DAILY_PROMPT: (typeof import("./scheduler.js"))["META_DAILY_PROMPT"];
let validateRecipient: (typeof import("../comms/recipient.js"))["validateRecipient"];

beforeAll(async () => {
  handle = await createTestDb({ label: "scheduler" });
  registry = await import("../agent/registry.js");
  ({
    upsertSchedule,
    deleteSchedule,
    seedMetaAgents,
    getSchedule,
    ScheduleNameCollisionError,
    META_DAILY_PROMPT,
  } = await import("./scheduler.js"));
  ({ validateRecipient } = await import("../comms/recipient.js"));
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

describe("upsertSchedule (FRI-76 eager registry)", () => {
  it("creates a scheduled-type registry stub with no session", async () => {
    await upsertSchedule({
      name: "demo-schedule",
      cron: "0 9 * * *",
      taskPrompt: "do the thing",
    });
    const a = await registry.getAgent("demo-schedule");
    expect(a).not.toBeNull();
    expect(a!.type).toBe("scheduled");
    expect(a!.status).toBe("idle");
    expect(a!.sessionId).toBeUndefined();
  });

  it("lets mail_send validation succeed against the not-yet-fired agent", async () => {
    await upsertSchedule({
      name: "pre-fire-target",
      cron: "0 9 * * *",
      taskPrompt: "x",
    });
    const r = await validateRecipient("pre-fire-target");
    expect(r).toEqual({ ok: true, agent: "pre-fire-target" });
  });

  it("rejects a schedule name that collides with an existing non-scheduled agent", async () => {
    await registry.registerAgent({
      name: "already-a-builder",
      type: "builder",
      parentName: "friday",
      worktreePath: "/tmp/x",
    });
    await expect(
      upsertSchedule({
        name: "already-a-builder",
        cron: "0 9 * * *",
        taskPrompt: "x",
      }),
    ).rejects.toThrow(ScheduleNameCollisionError);
    // schedule row was not created
    const rows = await getDb().select().from(schema.schedules);
    expect(rows.length).toBe(0);
  });

  it("is idempotent — re-upsert on an existing scheduled agent leaves the row alone", async () => {
    await upsertSchedule({
      name: "stable",
      cron: "0 9 * * *",
      taskPrompt: "v1",
    });
    const first = (await registry.getAgent("stable"))!;
    await upsertSchedule({
      name: "stable",
      cron: "0 10 * * *",
      taskPrompt: "v2",
    });
    const second = (await registry.getAgent("stable"))!;
    expect(second.type).toBe("scheduled");
    expect(second.createdAt).toBe(first.createdAt);
  });
});

describe("deleteSchedule (FRI-76 cleanup)", () => {
  it("removes the stub registry entry when the agent has never fired", async () => {
    await upsertSchedule({
      name: "ephemeral",
      cron: "0 9 * * *",
      taskPrompt: "x",
    });
    expect(await registry.getAgent("ephemeral")).not.toBeNull();
    expect(await deleteSchedule("ephemeral")).toBe(true);
    expect(await registry.getAgent("ephemeral")).toBeNull();
  });

  it("preserves the registry entry when the agent has session history", async () => {
    await upsertSchedule({
      name: "fired",
      cron: "0 9 * * *",
      taskPrompt: "x",
    });
    await registry.setSession("fired", "sess-123");
    expect(await deleteSchedule("fired")).toBe(true);
    const a = await registry.getAgent("fired");
    expect(a).not.toBeNull();
    expect(a!.sessionId).toBe("sess-123");
  });

  it("preserves the registry entry when blocks exist even without a current session", async () => {
    await upsertSchedule({
      name: "had-blocks",
      cron: "0 9 * * *",
      taskPrompt: "x",
    });
    await getDb().insert(schema.blocks).values({
      blockId: "b1",
      turnId: "t1",
      agentName: "had-blocks",
      sessionId: "sess-old",
      blockIndex: 0,
      role: "user",
      kind: "text",
      source: "schedule",
      contentJson: {},
      status: "complete",
      ts: new Date(),
    });
    expect(await deleteSchedule("had-blocks")).toBe(true);
    expect(await registry.getAgent("had-blocks")).not.toBeNull();
  });
});

describe("META_DAILY_PROMPT (FRI-40 auto-triage guidance)", () => {
  it("tells the meta-agent a triage helper may already be investigating", () => {
    // FRI-40 AC #9: when evolve.autoSpawnTriageHelpers is on, a read-only
    // triage helper is spawned at scan time, so the daily meta-agent must
    // mention it rather than ask the orchestrator to spawn one. Pin the exact
    // substring so a future prompt edit can't silently drop the guidance.
    expect(META_DAILY_PROMPT.includes("triage helper")).toBe(true);
  });
});

describe("META_DAILY_PROMPT (FRI-26 memory dreaming, AC6)", () => {
  it("drives the dreaming sub-pass via includeDreaming on the step-1 scan", () => {
    // The prompt edit alone is inert unless the meta-agent actually passes the
    // flag — the evolve_scan call must opt into the nightly dreaming sub-pass.
    // Pin the exact arg so a future prompt edit can't silently drop it.
    expect(META_DAILY_PROMPT.includes("includeDreaming: true")).toBe(true);
  });

  it("instructs the agent to round-trip lastDreamScannedTs as the next run's cursor", () => {
    // AC6: the dreaming cursor rides the agent's state.md (no code parser).
    // The prompt must tell the agent to RECORD lastDreamScannedTs so tomorrow's
    // run only re-scans newer turns. Pin the key name verbatim.
    expect(META_DAILY_PROMPT.includes("lastDreamScannedTs")).toBe(true);
  });
});

describe("seedMetaAgents (FRI-26 unconditional daily re-seed, AC6)", () => {
  it("refreshes an existing scheduled-meta-daily taskPrompt on every seed (ships prompt edits on update)", async () => {
    // Gotcha #8: a guarded (row-absent-only) seed makes a META_DAILY_PROMPT
    // edit inert on `friday update` — every deployed box already has the row.
    // Seed an existing row with a STALE prompt, then call seedMetaAgents and
    // assert it overwrote taskPrompt with the canonical META_DAILY_PROMPT.
    await upsertSchedule({
      name: "scheduled-meta-daily",
      cron: "0 4 * * *",
      taskPrompt: "STALE PROMPT — must be overwritten by seedMetaAgents",
    });
    const before = await getSchedule("scheduled-meta-daily");
    expect(before).not.toBeNull();
    expect(before!.taskPrompt).toBe("STALE PROMPT — must be overwritten by seedMetaAgents");

    await seedMetaAgents();

    const after = await getSchedule("scheduled-meta-daily");
    expect(after).not.toBeNull();
    expect(after!.taskPrompt).toBe(META_DAILY_PROMPT);
    // The unconditional upsert keeps the canonical daily cron.
    expect(after!.cron).toBe("0 4 * * *");
  });

  it("seeds scheduled-meta-daily from scratch when no row exists yet", async () => {
    expect(await getSchedule("scheduled-meta-daily")).toBeNull();
    await seedMetaAgents();
    const row = await getSchedule("scheduled-meta-daily");
    expect(row).not.toBeNull();
    expect(row!.taskPrompt).toBe(META_DAILY_PROMPT);
    expect(row!.cron).toBe("0 4 * * *");
  });

  it("preserves an operator's paused state + custom cron while refreshing the prompt (F3)", async () => {
    // Gotcha #3 (F3): a plain upsert in seedMetaAgents re-passes paused/cron/runAt
    // from the spec, so every boot would un-pause a deliberately-paused meta-agent
    // and force its cron back to "0 4 * * *". Seed a row the operator has paused
    // and re-crontab'd to 06:30, then assert seedMetaAgents refreshed ONLY the
    // prompt — paused + custom cron survive.
    await upsertSchedule({
      name: "scheduled-meta-daily",
      cron: "30 6 * * *",
      taskPrompt: "STALE PROMPT — operator customized this schedule",
      paused: true,
    });
    const before = await getSchedule("scheduled-meta-daily");
    expect(before).not.toBeNull();
    expect(before!.paused).toBe(true);
    expect(before!.cron).toBe("30 6 * * *");

    await seedMetaAgents();

    const after = await getSchedule("scheduled-meta-daily");
    expect(after).not.toBeNull();
    // Preserved: paused + custom cron untouched by the re-seed.
    expect(after!.paused).toBe(true);
    expect(after!.cron).toBe("30 6 * * *");
    // Refreshed: taskPrompt picks up the canonical prompt (ships prompt edits).
    expect(after!.taskPrompt).toBe(META_DAILY_PROMPT);
  });
});
