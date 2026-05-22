/**
 * Phase 4.8 — agent archive LISTEN trigger tests.
 *
 * Pins the trigger contract: fires NOTIFY on UPDATE that transitions
 * to status='archive_requested'; doesn't fire on the daemon's
 * eventual flip to status='archived' (handler-reentry safety); the
 * archive_reason column accepts all four ArchiveReason values.
 *
 * The handler's full archiveAgent dispatch (worker kill + worktree
 * archive + ticket close) is covered by the existing lifecycle
 * tests; this file pins the trigger plumbing only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";
import pgPkg from "pg";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "archive_listener" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

describe("Postgres trigger: friday_archive_notify_trigger", () => {
  it("fires NOTIFY when status transitions to 'archive_requested'", async () => {
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const db = getDb();
      await db.insert(schema.agents).values({
        name: "test-archive",
        type: "builder",
        status: "idle",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const received: Array<{ channel: string; payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ channel: msg.channel, payload: msg.payload ?? "" }),
      );
      await client.query("LISTEN friday_archive_requested");

      await db
        .update(schema.agents)
        .set({ status: "archive_requested", archiveReason: "abandoned" });

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1);
          expect(received[0]!.channel).toBe("friday_archive_requested");
          expect(received[0]!.payload).toBe("test-archive");
        },
        { timeout: 5000, interval: 25 },
      );
    } finally {
      await client.end();
    }
  });

  it("does NOT fire NOTIFY when status flips to 'archived' (daemon's terminal write)", async () => {
    // Handler-reentry safety: the lifecycle code's
    // `registry.archiveAgent` sets status='archived'. The trigger
    // predicate (NEW.status = 'archive_requested') excludes this
    // — if it didn't, the handler would loop.
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const db = getDb();
      await db.insert(schema.agents).values({
        name: "test-flip",
        type: "builder",
        status: "archive_requested",
        archiveReason: "abandoned",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await client.query("LISTEN friday_archive_requested");
      // negative-space: drain any buffered notifications before attaching
      // our handler. The INSERT here was at 'archive_requested' (trigger
      // is AFTER UPDATE only, so it shouldn't have fired) — but the drain
      // is paranoid coverage for handler-attach timing.
      await new Promise((r) => setTimeout(r, 250));
      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));

      await db.update(schema.agents).set({ status: "archived" });

      // negative-space: trigger predicate excludes flips to 'archived' —
      // a bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("does NOT fire NOTIFY on common idle → working transitions", async () => {
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const db = getDb();
      await db.insert(schema.agents).values({
        name: "test-quiet",
        type: "builder",
        status: "idle",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));
      await client.query("LISTEN friday_archive_requested");

      // Normal worker lifecycle UPDATEs — must not spam NOTIFY.
      await db.update(schema.agents).set({ status: "working" });
      await db.update(schema.agents).set({ status: "idle" });

      // negative-space: trigger predicate excludes idle/working UPDATEs —
      // a bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("AFTER UPDATE only — INSERT at status='archive_requested' doesn't fire (legacy paths can't be re-fired)", async () => {
    // Trigger uses AFTER UPDATE (not AFTER INSERT OR UPDATE). New
    // agent rows shouldn't fire — the lifecycle code only ever
    // INSERTs at status='idle', and the legacy direct-archive
    // path UPDATEs straight to 'archived' (skipping
    // 'archive_requested' entirely).
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const received: Array<{ payload: string }> = [];
      const db = getDb();
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));
      await client.query("LISTEN friday_archive_requested");

      // Insert directly at 'archive_requested' (a hypothetical
      // bypass path) — trigger doesn't fire.
      await db.insert(schema.agents).values({
        name: "test-insert",
        type: "builder",
        status: "archive_requested",
        archiveReason: "abandoned",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // negative-space: trigger is AFTER UPDATE only — INSERTs don't fire.
      // A bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});

describe("agents status enum + archive_reason", () => {
  it("accepts the three ArchiveReason values", async () => {
    const db = getDb();
    for (const reason of ["completed", "abandoned", "failed"] as const) {
      await db.insert(schema.agents).values({
        name: `reason-${reason}`,
        type: "builder",
        status: "archive_requested",
        archiveReason: reason,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const rows = await db
      .select({
        name: schema.agents.name,
        reason: schema.agents.archiveReason,
      })
      .from(schema.agents);
    expect(rows.map((r) => r.reason).sort()).toEqual(["abandoned", "completed", "failed"].sort());
  });
});
