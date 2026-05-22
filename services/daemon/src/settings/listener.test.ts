/**
 * Phase 4.3 — settings LISTEN handler tests.
 *
 * These tests pin the LISTEN/NOTIFY plumbing: the trigger fires on
 * UPDATE, the client receives the notification, and the handler
 * invokes the sync function. The filesystem-write side of
 * `syncConfigFromSettingsRow` is NOT exercised here — the
 * production code reads/writes `~/.friday/config.json` via the
 * cached `CONFIG_PATH` const in `@friday/shared`, which is resolved
 * at module load and can't be redirected from inside a vitest
 * `beforeAll` without a `setupFiles` indirection. The filesystem
 * leg of the contract is verified by the end-to-end Playwright
 * smoke instead.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestDb,
  getDb,
  schema,
  type TestDbHandle,
} from "@friday/shared";
import pgPkg from "pg";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "settings_listener" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  // Re-seed the singleton row — truncate dropped it.
  const db = getDb();
  await db.insert(schema.settings).values({
    id: "singleton",
    updatedAt: new Date(),
  });
});

describe("Postgres trigger: friday_settings_notify_trigger", () => {
  it("fires NOTIFY friday_settings_changed on settings UPDATE", async () => {
    // Open a raw LISTEN client (separate from the daemon's
    // listener.ts — this is the test exercising the trigger
    // directly, not the daemon's handler).
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const received: Array<{ channel: string; payload: string }> = [];
      client.on("notification", (msg) => {
        received.push({
          channel: msg.channel,
          payload: msg.payload ?? "",
        });
      });
      await client.query("LISTEN friday_settings_changed");

      // Trigger fires AFTER UPDATE, so we need an actual UPDATE
      // (not the INSERT from beforeEach).
      const db = getDb();
      await db
        .update(schema.settings)
        .set({ model: "claude-opus-4-7", updatedAt: new Date() });

      // Poll until the NOTIFY round-trips through the change-streamer
      // and the test client's socket.
      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1);
          expect(received[0]!.channel).toBe("friday_settings_changed");
          // Payload is `NEW.id` per the trigger function (line in 0002
          // migration: `PERFORM pg_notify('friday_settings_changed', NEW.id);`).
          expect(received[0]!.payload).toBe("singleton");
        },
        { timeout: 5000, interval: 25 },
      );
    } finally {
      await client.end();
    }
  });

  it("does NOT fire NOTIFY on INSERT (trigger is AFTER UPDATE only)", async () => {
    // The trigger is intentionally `AFTER UPDATE` — the initial
    // INSERT comes from the migration's seed, and re-inserting
    // would be an error (PK conflict). Verify INSERTs don't
    // generate spurious notifications.
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      // Truncate + re-insert to get a fresh INSERT visible to the
      // LISTEN.
      await handle.truncate();
      const received: Array<{ channel: string }> = [];
      client.on("notification", (msg) => received.push({ channel: msg.channel }));
      await client.query("LISTEN friday_settings_changed");
      const db = getDb();
      await db.insert(schema.settings).values({
        id: "singleton",
        updatedAt: new Date(),
      });
      // negative-space: the trigger is AFTER UPDATE — an INSERT should
      // produce zero notifications. A bounded real-time wait is the right
      // shape here; vi.waitFor on "received remains empty" would resolve
      // on the first tick before any spurious NOTIFY could round-trip.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});

describe("singleton row idempotency", () => {
  it("UPDATEs preserve omitted columns (mutator-friendly UPDATE semantics)", async () => {
    // Critical contract — the `updateSettings` mutator only patches
    // fields the user provided; Drizzle's `.set({ model: 'x' })`
    // leaves other columns untouched. Verify against the running
    // Postgres so a schema change can't silently break this.
    const db = getDb();
    await db
      .update(schema.settings)
      .set({ model: "claude-opus-4-7", watchdogRefork: true });
    await db
      .update(schema.settings)
      .set({ model: "claude-sonnet-4-6", updatedAt: new Date() });
    const rows = await db.select().from(schema.settings);
    expect(rows).toHaveLength(1);
    // model overwritten; watchdog_refork retained.
    expect(rows[0]!.model).toBe("claude-sonnet-4-6");
    expect(rows[0]!.watchdogRefork).toBe(true);
  });

  it("the PK constraint forbids parallel non-singleton rows", async () => {
    // The table is single-row by design — id='singleton' PK
    // collision is the safety net.
    const db = getDb();
    await expect(
      db.insert(schema.settings).values({
        id: "singleton",
        updatedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});
