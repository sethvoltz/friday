/**
 * FRI-76: schedule_upsert eagerly registers a stub agent so mail to a
 * scheduled agent passes recipient validation before its first fire.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDb,
  getDb,
  schema,
  type TestDbHandle,
} from "@friday/shared";

let handle: TestDbHandle;
let registry: typeof import("../agent/registry.js");
let upsertSchedule: typeof import("./scheduler.js")["upsertSchedule"];
let deleteSchedule: typeof import("./scheduler.js")["deleteSchedule"];
let ScheduleNameCollisionError: typeof import("./scheduler.js")["ScheduleNameCollisionError"];
let validateRecipient: typeof import("../comms/recipient.js")["validateRecipient"];

beforeAll(async () => {
  handle = await createTestDb({ label: "scheduler" });
  registry = await import("../agent/registry.js");
  ({ upsertSchedule, deleteSchedule, ScheduleNameCollisionError } =
    await import("./scheduler.js"));
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
      lastEventSeq: 0,
    });
    expect(await deleteSchedule("had-blocks")).toBe(true);
    expect(await registry.getAgent("had-blocks")).not.toBeNull();
  });
});
