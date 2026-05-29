/**
 * Phase 4.6 — schedules LISTEN handler tests.
 *
 * Same template as the memory + settings listener tests: verify the
 * trigger fires NOTIFY on the right status transitions, doesn't
 * fire on the wrong ones, and the row state transitions behave as
 * the daemon's handler expects. The full handler — registry-stub
 * coordination + nextRunAt computation — is verified by the
 * end-to-end smoke (psql + daemon log).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, getDb, schema, type TestDbHandle, newTestClient } from "@friday/shared";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "schedule_listener" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

describe("Postgres trigger: friday_schedule_notify_trigger", () => {
  it("fires NOTIFY on INSERT with status='pending_register'", async () => {
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const received: Array<{ channel: string; payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ channel: msg.channel, payload: msg.payload ?? "" }),
      );
      await client.query("LISTEN friday_schedule_changed");

      const db = getDb();
      await db.insert(schema.schedules).values({
        name: "test-create",
        cron: "0 8 * * *",
        runAt: null,
        taskPrompt: "summarize",
        paused: false,
        nextRunAt: null,
        lastRunAt: null,
        lastRunId: null,
        metaJson: null,
        appId: null,
        status: "pending_register",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1);
          expect(received[0]!.channel).toBe("friday_schedule_changed");
          expect(received[0]!.payload).toBe("test-create");
        },
        { timeout: 5000, interval: 25 },
      );
    } finally {
      await client.end();
    }
  });

  it("fires NOTIFY on UPDATE to status='reload_requested'", async () => {
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const db = getDb();
      await db.insert(schema.schedules).values({
        name: "test-update",
        cron: "0 8 * * *",
        runAt: null,
        taskPrompt: "X",
        paused: false,
        nextRunAt: null,
        lastRunAt: null,
        lastRunId: null,
        metaJson: null,
        appId: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));
      await client.query("LISTEN friday_schedule_changed");

      await db.update(schema.schedules).set({ status: "reload_requested", updatedAt: new Date() });

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1);
          expect(received[0]!.payload).toBe("test-update");
        },
        { timeout: 5000, interval: 25 },
      );
    } finally {
      await client.end();
    }
  });

  it("fires NOTIFY on UPDATE to status='deleted'", async () => {
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const db = getDb();
      await db.insert(schema.schedules).values({
        name: "test-delete",
        cron: "0 8 * * *",
        runAt: null,
        taskPrompt: "X",
        paused: false,
        nextRunAt: null,
        lastRunAt: null,
        lastRunId: null,
        metaJson: null,
        appId: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));
      await client.query("LISTEN friday_schedule_changed");

      await db.update(schema.schedules).set({ status: "deleted", updatedAt: new Date() });

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1);
          expect(received[0]!.payload).toBe("test-delete");
        },
        { timeout: 5000, interval: 25 },
      );
    } finally {
      await client.end();
    }
  });

  it("does NOT fire NOTIFY on UPDATE that stays at 'active'", async () => {
    // The daemon's own flip-back UPDATE (pending_register → active)
    // shouldn't re-enter the handler. The trigger predicate
    // excludes 'active' precisely to prevent this loop.
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const db = getDb();
      await db.insert(schema.schedules).values({
        name: "test-quiet",
        cron: "0 8 * * *",
        runAt: null,
        taskPrompt: "X",
        paused: false,
        nextRunAt: null,
        lastRunAt: null,
        lastRunId: null,
        metaJson: null,
        appId: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));
      await client.query("LISTEN friday_schedule_changed");

      // Bumps nextRunAt — common scheduler-tick behavior — but
      // status stays 'active'. No NOTIFY expected.
      await db.update(schema.schedules).set({ nextRunAt: new Date(), updatedAt: new Date() });

      // negative-space: the trigger predicate excludes 'active' UPDATEs —
      // a bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("does NOT fire NOTIFY when daemon flips from 'pending_register' back to 'active'", async () => {
    // Handler-reentry safety: the LISTEN handler's terminal write
    // (status='active') must not trigger a re-fire.
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const db = getDb();
      await db.insert(schema.schedules).values({
        name: "test-flip",
        cron: "0 8 * * *",
        runAt: null,
        taskPrompt: "X",
        paused: false,
        nextRunAt: null,
        lastRunAt: null,
        lastRunId: null,
        metaJson: null,
        appId: null,
        status: "pending_register",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // negative-space: drain the initial fire from the pending_register
      // INSERT before attaching our handler so the assertion below isn't
      // polluted by buffered notifications.
      await client.query("LISTEN friday_schedule_changed");
      await new Promise((r) => setTimeout(r, 250));
      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));

      await db.update(schema.schedules).set({ status: "active" });

      // negative-space: the trigger predicate excludes 'active' UPDATEs —
      // a bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});

describe("schedules status enum", () => {
  it("accepts 'pending_register', 'reload_requested', and 'deleted'", async () => {
    const db = getDb();
    for (const status of ["pending_register", "reload_requested", "deleted"] as const) {
      await db.insert(schema.schedules).values({
        name: `enum-test-${status}`,
        cron: null,
        runAt: null,
        taskPrompt: "X",
        paused: false,
        nextRunAt: null,
        lastRunAt: null,
        lastRunId: null,
        metaJson: null,
        appId: null,
        status,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const rows = await db.select().from(schema.schedules);
    expect(rows.map((r) => r.status).sort()).toEqual(
      ["deleted", "pending_register", "reload_requested"].sort(),
    );
  });
});
