/**
 * FRI-76: schedule_upsert eagerly registers a stub agent so mail to a
 * scheduled agent passes recipient validation before its first fire.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "friday-scheduler-"));
process.env.FRIDAY_DATA_DIR = dataDir;

const { runMigrations, closeDb, getRawDb, getDb, schema } = await import(
  "@friday/shared"
);
const registry = await import("../agent/registry.js");
const {
  upsertSchedule,
  deleteSchedule,
  ScheduleNameCollisionError,
} = await import("./scheduler.js");
const { validateRecipient } = await import("../comms/recipient.js");

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const raw = getRawDb();
  raw.prepare("DELETE FROM blocks").run();
  raw.prepare("DELETE FROM schedules").run();
  raw.prepare("DELETE FROM agents").run();
});

describe("upsertSchedule (FRI-76 eager registry)", () => {
  it("creates a scheduled-type registry stub with no session", () => {
    upsertSchedule({
      name: "demo-schedule",
      cron: "0 9 * * *",
      taskPrompt: "do the thing",
    });
    const a = registry.getAgent("demo-schedule");
    expect(a).not.toBeNull();
    expect(a!.type).toBe("scheduled");
    expect(a!.status).toBe("idle");
    expect(a!.sessionId).toBeUndefined();
  });

  it("lets mail_send validation succeed against the not-yet-fired agent", () => {
    upsertSchedule({
      name: "pre-fire-target",
      cron: "0 9 * * *",
      taskPrompt: "x",
    });
    const r = validateRecipient("pre-fire-target");
    expect(r).toEqual({ ok: true, agent: "pre-fire-target" });
  });

  it("rejects a schedule name that collides with an existing non-scheduled agent", () => {
    registry.registerAgent({
      name: "already-a-builder",
      type: "builder",
      parentName: "friday",
      worktreePath: "/tmp/x",
    });
    expect(() =>
      upsertSchedule({
        name: "already-a-builder",
        cron: "0 9 * * *",
        taskPrompt: "x",
      }),
    ).toThrow(ScheduleNameCollisionError);
    // schedule row was not created
    const row = getDb()
      .select()
      .from(schema.schedules)
      .all();
    expect(row.length).toBe(0);
  });

  it("is idempotent — re-upsert on an existing scheduled agent leaves the row alone", () => {
    upsertSchedule({
      name: "stable",
      cron: "0 9 * * *",
      taskPrompt: "v1",
    });
    const first = registry.getAgent("stable")!;
    upsertSchedule({
      name: "stable",
      cron: "0 10 * * *",
      taskPrompt: "v2",
    });
    const second = registry.getAgent("stable")!;
    expect(second.type).toBe("scheduled");
    expect(second.createdAt).toBe(first.createdAt);
  });
});

describe("deleteSchedule (FRI-76 cleanup)", () => {
  it("removes the stub registry entry when the agent has never fired", () => {
    upsertSchedule({
      name: "ephemeral",
      cron: "0 9 * * *",
      taskPrompt: "x",
    });
    expect(registry.getAgent("ephemeral")).not.toBeNull();
    expect(deleteSchedule("ephemeral")).toBe(true);
    expect(registry.getAgent("ephemeral")).toBeNull();
  });

  it("preserves the registry entry when the agent has session history", () => {
    upsertSchedule({
      name: "fired",
      cron: "0 9 * * *",
      taskPrompt: "x",
    });
    registry.setSession("fired", "sess-123");
    expect(deleteSchedule("fired")).toBe(true);
    const a = registry.getAgent("fired");
    expect(a).not.toBeNull();
    expect(a!.sessionId).toBe("sess-123");
  });

  it("preserves the registry entry when blocks exist even without a current session", () => {
    upsertSchedule({
      name: "had-blocks",
      cron: "0 9 * * *",
      taskPrompt: "x",
    });
    getDb()
      .insert(schema.blocks)
      .values({
        blockId: "b1",
        turnId: "t1",
        agentName: "had-blocks",
        sessionId: "sess-old",
        blockIndex: 0,
        role: "user",
        kind: "text",
        source: "schedule",
        contentJson: "{}",
        status: "complete",
        ts: Date.now(),
        lastEventSeq: 0,
      })
      .run();
    expect(deleteSchedule("had-blocks")).toBe(true);
    expect(registry.getAgent("had-blocks")).not.toBeNull();
  });
});
