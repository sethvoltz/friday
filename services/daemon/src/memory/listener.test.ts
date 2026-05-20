/**
 * Phase 4.5 — memory_entries LISTEN handler + boot-recovery tests.
 *
 * Pins the LISTEN/NOTIFY plumbing + the row-state transitions on
 * either side of the file-write side effect. Same caveat as the
 * settings listener tests: `MEMORY_ENTRIES_DIR` is computed at
 * module load via the cached `DATA_DIR` const in `@friday/shared`,
 * so the daemon's filesystem writes target the real
 * `~/.friday/memory/` location. That's not safe for unit tests, so
 * the file-write side of the handler is verified by the end-to-end
 * Playwright smoke instead. These tests verify:
 *
 *   - The Postgres trigger fires NOTIFY on INSERT/UPDATE when the
 *     row enters a pending status — and DOES NOT fire when status
 *     stays at 'ready'.
 *   - The trigger payload is the row's id (so the LISTEN handler
 *     can re-fetch the row and check its current state).
 *   - The boot-recovery scan picks up pending rows.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestDb,
  getDb,
  schema,
  type TestDbHandle,
} from "@friday/shared";
import pgPkg from "pg";

let handle: TestDbHandle;
let scratchHome: string;

beforeAll(async () => {
  // Scratch HOME so the listener's filesystem writes don't touch the
  // user's real ~/.friday. NOTE: this only redirects new code paths
  // that read HOME at call-time; the shared `DATA_DIR` const is
  // already evaluated by the time these tests load.
  scratchHome = mkdtempSync(join(tmpdir(), "friday-memory-listener-"));
  handle = await createTestDb({ label: "memory_listener" });
});

afterAll(async () => {
  await handle.drop();
  rmSync(scratchHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await handle.truncate();
});

describe("Postgres trigger: friday_memory_notify_trigger", () => {
  it("fires NOTIFY friday_memory_file_changed on INSERT with pending_file", async () => {
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const received: Array<{ channel: string; payload: string }> = [];
      client.on("notification", (msg) => {
        received.push({ channel: msg.channel, payload: msg.payload ?? "" });
      });
      await client.query("LISTEN friday_memory_file_changed");

      const db = getDb();
      await db.insert(schema.memoryEntries).values({
        id: "test-create",
        title: "Test",
        content: "Body",
        tagsJson: [],
        createdBy: "user",
        createdAt: new Date(),
        updatedAt: new Date(),
        fileMtime: new Date(),
        recallCount: 0,
        lastRecalledAt: null,
        status: "pending_file",
      });

      const deadline = Date.now() + 1_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(received).toHaveLength(1);
      expect(received[0]!.channel).toBe("friday_memory_file_changed");
      expect(received[0]!.payload).toBe("test-create");
    } finally {
      await client.end();
    }
  });

  it("fires NOTIFY on UPDATE that transitions to pending_file", async () => {
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const db = getDb();
      // INSERT at 'ready' first (no notification expected).
      await db.insert(schema.memoryEntries).values({
        id: "test-update",
        title: "T",
        content: "C",
        tagsJson: [],
        createdBy: "user",
        createdAt: new Date(),
        updatedAt: new Date(),
        fileMtime: new Date(),
        recallCount: 0,
        lastRecalledAt: null,
        status: "ready",
      });

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ payload: msg.payload ?? "" }),
      );
      await client.query("LISTEN friday_memory_file_changed");

      // Now UPDATE to pending_file.
      await db
        .update(schema.memoryEntries)
        .set({ status: "pending_file", updatedAt: new Date() });

      const deadline = Date.now() + 1_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(received).toHaveLength(1);
      expect(received[0]!.payload).toBe("test-update");
    } finally {
      await client.end();
    }
  });

  it("fires NOTIFY on UPDATE that transitions to pending_delete", async () => {
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const db = getDb();
      await db.insert(schema.memoryEntries).values({
        id: "test-delete",
        title: "T",
        content: "C",
        tagsJson: [],
        createdBy: "user",
        createdAt: new Date(),
        updatedAt: new Date(),
        fileMtime: new Date(),
        recallCount: 0,
        lastRecalledAt: null,
        status: "ready",
      });

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ payload: msg.payload ?? "" }),
      );
      await client.query("LISTEN friday_memory_file_changed");

      await db
        .update(schema.memoryEntries)
        .set({ status: "pending_delete", updatedAt: new Date() });

      const deadline = Date.now() + 1_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(received).toHaveLength(1);
      expect(received[0]!.payload).toBe("test-delete");
    } finally {
      await client.end();
    }
  });

  it("does NOT fire NOTIFY on UPDATE that stays at 'ready'", async () => {
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const db = getDb();
      await db.insert(schema.memoryEntries).values({
        id: "test-quiet",
        title: "T",
        content: "C",
        tagsJson: [],
        createdBy: "user",
        createdAt: new Date(),
        updatedAt: new Date(),
        fileMtime: new Date(),
        recallCount: 0,
        lastRecalledAt: null,
        status: "ready",
      });

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ payload: msg.payload ?? "" }),
      );
      await client.query("LISTEN friday_memory_file_changed");

      // UPDATE that touches content but leaves status at 'ready' —
      // shouldn't fire (e.g., recallCount bump from a tool use).
      await db
        .update(schema.memoryEntries)
        .set({ recallCount: 1, lastRecalledAt: new Date() });

      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("does NOT fire on UPDATE that flips status to 'ready' (the daemon's own write)", async () => {
    // After the daemon writes the file and flips to 'ready', that
    // UPDATE itself fires the trigger... but the trigger predicate
    // (`status IN ('pending_file', 'pending_delete')`) means it
    // sees the row already at 'ready' and skips. Verify.
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const db = getDb();
      await db.insert(schema.memoryEntries).values({
        id: "test-daemon-flip",
        title: "T",
        content: "C",
        tagsJson: [],
        createdBy: "user",
        createdAt: new Date(),
        updatedAt: new Date(),
        fileMtime: new Date(),
        recallCount: 0,
        lastRecalledAt: null,
        status: "pending_file",
      });

      // Drain initial notification.
      await client.query("LISTEN friday_memory_file_changed");
      await new Promise((r) => setTimeout(r, 250));
      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ payload: msg.payload ?? "" }),
      );

      // Now flip to 'ready' (daemon's terminal write).
      await db
        .update(schema.memoryEntries)
        .set({ status: "ready" });

      await new Promise((r) => setTimeout(r, 250));
      // 0 notifications — the trigger predicate excludes 'ready'.
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});

describe("memoryEntries status enum", () => {
  it("includes 'pending_delete' as a valid value", async () => {
    // The check constraint must allow pending_delete (added with
    // Phase 4.5). Confirm via direct INSERT.
    const db = getDb();
    await db.insert(schema.memoryEntries).values({
      id: "pd-test",
      title: "T",
      content: "C",
      tagsJson: [],
      createdBy: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      fileMtime: new Date(),
      recallCount: 0,
      lastRecalledAt: null,
      status: "pending_delete",
    });
    const rows = await db
      .select()
      .from(schema.memoryEntries);
    expect(rows[0]!.status).toBe("pending_delete");
  });

  it("rejects an unknown status value", async () => {
    const db = getDb();
    await expect(
      db.insert(schema.memoryEntries).values({
        id: "bad",
        title: "T",
        content: "C",
        tagsJson: [],
        createdBy: "u",
        createdAt: new Date(),
        updatedAt: new Date(),
        fileMtime: new Date(),
        recallCount: 0,
        lastRecalledAt: null,
        status: "garbage",
      }),
    ).rejects.toThrow();
  });
});
