/**
 * Phase 4.7 — apps LISTEN trigger tests.
 *
 * Pins the LISTEN/NOTIFY plumbing for the apps table. The handler's
 * full installer logic is covered by the existing
 * `installer.test.ts` suite (the listener just dispatches to those
 * already-tested functions); this file pins the trigger contract.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, getDb, schema, type TestDbHandle, newTestClient } from "@friday/shared";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "app_listener" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

describe("Postgres trigger: friday_app_notify_trigger", () => {
  it("fires NOTIFY on INSERT with status='pending_install'", async () => {
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const received: Array<{ channel: string; payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ channel: msg.channel, payload: msg.payload ?? "" }),
      );
      await client.query("LISTEN friday_app_changed");

      const db = getDb();
      await db.insert(schema.apps).values({
        id: "test-install",
        name: "",
        version: "0.0.0",
        manifestVersion: 0,
        folderPath: "/tmp/test-install",
        manifestJson: {},
        status: "pending_install",
        installedAt: new Date(),
        upgradedAt: null,
        metaJson: null,
      });

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1);
          expect(received[0]!.channel).toBe("friday_app_changed");
          expect(received[0]!.payload).toBe("test-install");
        },
        { timeout: 5000, interval: 25 },
      );
    } finally {
      await client.end();
    }
  });

  it("fires NOTIFY on UPDATE to status='uninstall_requested'", async () => {
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const db = getDb();
      await db.insert(schema.apps).values({
        id: "test-uninstall",
        name: "Test",
        version: "1.0.0",
        manifestVersion: 1,
        folderPath: "/tmp/test-uninstall",
        manifestJson: { id: "test-uninstall" },
        status: "installed",
        installedAt: new Date(),
        upgradedAt: null,
        metaJson: null,
      });

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));
      await client.query("LISTEN friday_app_changed");

      await db.update(schema.apps).set({ status: "uninstall_requested" });

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1);
          expect(received[0]!.payload).toBe("test-uninstall");
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
      await db.insert(schema.apps).values({
        id: "test-reload",
        name: "Test",
        version: "1.0.0",
        manifestVersion: 1,
        folderPath: "/tmp/test-reload",
        manifestJson: { id: "test-reload" },
        status: "installed",
        installedAt: new Date(),
        upgradedAt: null,
        metaJson: null,
      });

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));
      await client.query("LISTEN friday_app_changed");

      await db.update(schema.apps).set({ status: "reload_requested" });

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1);
          expect(received[0]!.payload).toBe("test-reload");
        },
        { timeout: 5000, interval: 25 },
      );
    } finally {
      await client.end();
    }
  });

  it("does NOT fire NOTIFY on UPDATE that stays at 'installed'", async () => {
    // The daemon's own flip-back UPDATE (pending_install → installed)
    // shouldn't re-enter the handler. Trigger predicate excludes
    // 'installed' precisely to prevent this loop.
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const db = getDb();
      await db.insert(schema.apps).values({
        id: "test-quiet",
        name: "Test",
        version: "1.0.0",
        manifestVersion: 1,
        folderPath: "/tmp/test-quiet",
        manifestJson: { id: "test-quiet" },
        status: "installed",
        installedAt: new Date(),
        upgradedAt: null,
        metaJson: null,
      });

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));
      await client.query("LISTEN friday_app_changed");

      // Common no-op UPDATE (version bump via the daemon — stays
      // at 'installed').
      await db.update(schema.apps).set({ version: "1.0.1", upgradedAt: new Date() });

      // negative-space: trigger predicate excludes 'installed' UPDATEs —
      // a bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("does NOT fire NOTIFY when daemon flips pending_install → installed", async () => {
    // Handler-reentry safety: the LISTEN handler's terminal flip
    // (status='installed') must not re-fire the trigger.
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const db = getDb();
      await db.insert(schema.apps).values({
        id: "test-flip",
        name: "",
        version: "0.0.0",
        manifestVersion: 0,
        folderPath: "/tmp/test-flip",
        manifestJson: {},
        status: "pending_install",
        installedAt: new Date(),
        upgradedAt: null,
        metaJson: null,
      });

      await client.query("LISTEN friday_app_changed");
      // negative-space: drain the pending_install INSERT notification
      // before attaching our handler so the assertion below isn't polluted.
      await new Promise((r) => setTimeout(r, 250));
      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));

      await db.update(schema.apps).set({
        status: "installed",
        name: "Real Name",
        version: "1.0.0",
        manifestVersion: 1,
        manifestJson: { id: "test-flip" },
      });

      // negative-space: trigger predicate excludes 'installed' UPDATEs —
      // a bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});

describe("apps status enum", () => {
  it("accepts the three pending statuses", async () => {
    const db = getDb();
    for (const status of ["pending_install", "uninstall_requested", "reload_requested"] as const) {
      await db.insert(schema.apps).values({
        id: `enum-${status}`,
        name: "",
        version: "0.0.0",
        manifestVersion: 0,
        folderPath: `/tmp/enum-${status}`,
        manifestJson: {},
        status,
        installedAt: new Date(),
        upgradedAt: null,
        metaJson: null,
      });
    }
    const rows = await db.select().from(schema.apps);
    expect(rows.map((r) => r.status).sort()).toEqual(
      ["pending_install", "reload_requested", "uninstall_requested"].sort(),
    );
  });
});
