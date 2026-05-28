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
import { readFileSync } from "node:fs";
import {
  CONFIG_PATH,
  createTestDb,
  getDb,
  loadConfig,
  schema,
  writeConfig,
  type TestDbHandle,
} from "@friday/shared";
import pgPkg from "pg";
import { syncConfigFromSettingsRow } from "./listener.js";

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
      await db.update(schema.settings).set({ model: "claude-opus-4-7", updatedAt: new Date() });

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
    await db.update(schema.settings).set({ model: "claude-opus-4-7", watchdogRefork: true });
    await db.update(schema.settings).set({ model: "claude-sonnet-4-6", updatedAt: new Date() });
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

describe("FRI-124: daemon LISTEN handler ignores theme columns", () => {
  it("syncConfigFromSettingsRow does not write config.json when only theme columns change", async () => {
    // Theme state is dashboard-only — the daemon's config.json mirror
    // covers `model` and `watchdog.refork`, nothing else. A settings row
    // where every theme column is set to a non-default value but model
    // and watchdogRefork remain at their defaults MUST NOT cause the
    // daemon to rewrite config.json (which would advance mtime and
    // potentially trigger downstream reload paths). Bytes-identical
    // before/after is the contract.
    const db = getDb();
    // Prime the row with non-null theme columns + null model/watchdog.
    // The mutator would produce this state when the dashboard user
    // configures their Appearance without touching the model/watchdog
    // controls.
    await db.update(schema.settings).set({
      themeKind: "single",
      themePaletteSingle: "dusk",
      themePaletteLight: "dawn",
      themePaletteDark: "dusk",
      updatedAt: new Date(),
    });

    // Materialize config.json on disk so we can compare bytes. The
    // vitest-setup forces FRIDAY_DATA_DIR into a tmpdir; loadConfig
    // returns DEFAULT_CONFIG in memory if the file doesn't exist but
    // does NOT create it, so we writeConfig once to commit defaults
    // to disk as the baseline.
    writeConfig(loadConfig());
    const before = readFileSync(CONFIG_PATH, "utf8");

    const changed = await syncConfigFromSettingsRow();
    expect(changed).toBe(false);

    const after = readFileSync(CONFIG_PATH, "utf8");
    expect(after).toBe(before);
  });

  it("syncConfigFromSettingsRow still writes when model changes alongside theme columns", async () => {
    // Defensive — proving the negative isn't enough. A mixed update
    // (theme + model) must still cause a write because model is the
    // load-bearing field. This guards against a future refactor that
    // accidentally skips writes whenever any theme column is set.
    //
    // Pick a model value that differs from DEFAULT_CONFIG.model so the
    // "row.model !== cfg.model" branch fires regardless of what default
    // ships. Reading cfg first lets the test stay correct if the default
    // ever changes.
    const cfg = loadConfig();
    const differentModel =
      cfg.model === "claude-opus-4-7" ? "claude-sonnet-4-6" : "claude-opus-4-7";
    const db = getDb();
    await db.update(schema.settings).set({
      model: differentModel,
      themeKind: "sync",
      themePaletteLight: "dawn",
      updatedAt: new Date(),
    });

    const changed = await syncConfigFromSettingsRow();
    expect(changed).toBe(true);

    // And the written config.json picked up only the model — no theme
    // keys leaked into the file.
    const written = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    expect(written.model).toBe(differentModel);
    expect("themeKind" in written).toBe(false);
    expect("themePaletteSingle" in written).toBe(false);
    expect("themePaletteLight" in written).toBe(false);
    expect("themePaletteDark" in written).toBe(false);
  });
});
