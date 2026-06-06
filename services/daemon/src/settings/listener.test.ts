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
  type FridayConfig,
  type TestDbHandle,
  newTestClient,
} from "@friday/shared";
import { syncConfigFromSettingsRow } from "./listener.js";

// FRI-16 (AC #20): the idempotency tests below count writeConfig calls —
// "exactly one writeConfig per real change, zero on a byte-identical
// rerun". Wrap the real implementation in a pass-through spy so the
// filesystem leg keeps working while calls stay observable. Module
// identity is shared with listener.ts's own import, so the spy sees the
// production call path, not a test-local copy.
vi.mock("@friday/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@friday/shared")>();
  return { ...actual, writeConfig: vi.fn(actual.writeConfig) };
});

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
    const client = newTestClient({ connectionString: handle.databaseUrl });
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
    const client = newTestClient({ connectionString: handle.databaseUrl });
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

    // Materialize the file so we have a baseline byte stream to compare
    // the post-sync write against. Without this priming write, the
    // first writeConfig from inside syncConfigFromSettingsRow would
    // create the file from nothing — making "before" and "after" both
    // valid but incomparable.
    writeConfig(loadConfig());
    const before = readFileSync(CONFIG_PATH, "utf8");

    const changed = await syncConfigFromSettingsRow();
    expect(changed).toBe(true);

    const after = readFileSync(CONFIG_PATH, "utf8");
    expect(after).not.toBe(before);

    // And the written config.json picked up only the model — no theme
    // keys leaked into the file.
    const written = JSON.parse(after) as Record<string, unknown>;
    expect(written.model).toBe(differentModel);
    expect("themeKind" in written).toBe(false);
    expect("themePaletteSingle" in written).toBe(false);
    expect("themePaletteLight" in written).toBe(false);
    expect("themePaletteDark" in written).toBe(false);
  });
});

describe("FRI-16: per-role / per-evolve-task model mirrors (AC #20)", () => {
  it("mirrors row.models into cfg.models with exactly one writeConfig; byte-identical rerun is a no-op", async () => {
    const db = getDb();
    const models = { builder: "claude-sonnet-4-6", helper: "claude-haiku-4-5-20251001" };
    await db.update(schema.settings).set({ models, updatedAt: new Date() });

    // Materialize config.json as the baseline, then zero the call count so
    // only the production sync path's writes are counted.
    writeConfig(loadConfig());
    vi.mocked(writeConfig).mockClear();

    const changed = await syncConfigFromSettingsRow();
    expect(changed).toBe(true);
    expect(writeConfig).toHaveBeenCalledTimes(1);
    const written = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FridayConfig;
    expect(written.models).toEqual(models);

    // Rerun: Drizzle returns a FRESH object reference for the jsonb column
    // on every query, so an identity (!==) check would always fire. The
    // sorted-key deep-equal must report no change — and must NOT rewrite
    // config.json (not even with identical bytes).
    const changedAgain = await syncConfigFromSettingsRow();
    expect(changedAgain).toBe(false);
    expect(writeConfig).toHaveBeenCalledTimes(1);
  });

  it("mirrors row.evolveModels (including ModelConfig object values) into cfg.evolve.models", async () => {
    const db = getDb();
    const evolveModels = {
      enrich: { name: "claude-sonnet-4-6", effort: "low" },
      scanFriction: "claude-haiku-4-5-20251001",
    };
    await db.update(schema.settings).set({ evolveModels, updatedAt: new Date() });

    writeConfig(loadConfig());
    vi.mocked(writeConfig).mockClear();

    const changed = await syncConfigFromSettingsRow();
    expect(changed).toBe(true);
    expect(writeConfig).toHaveBeenCalledTimes(1);
    const written = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FridayConfig;
    expect(written.evolve?.models).toEqual(evolveModels);

    // Nested-object deep-equal: the rerun must be a no-op too.
    const changedAgain = await syncConfigFromSettingsRow();
    expect(changedAgain).toBe(false);
    expect(writeConfig).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite when cfg.models matches row.models despite different key insertion order", async () => {
    // Postgres normalizes jsonb key order independently of insertion
    // order, and the file may hold keys in whatever order the user (or a
    // prior write) produced. Same content + different order must compare
    // equal — a plain JSON.stringify comparison would spuriously rewrite.
    const db = getDb();
    await db.update(schema.settings).set({
      models: { builder: "claude-sonnet-4-6", scheduled: "claude-haiku-4-5-20251001" },
      updatedAt: new Date(),
    });

    const cfg = loadConfig();
    // Reversed insertion order relative to the row write above.
    cfg.models = { scheduled: "claude-haiku-4-5-20251001", builder: "claude-sonnet-4-6" };
    writeConfig(cfg);
    const before = readFileSync(CONFIG_PATH, "utf8");
    vi.mocked(writeConfig).mockClear();

    const changed = await syncConfigFromSettingsRow();
    expect(changed).toBe(false);
    expect(writeConfig).not.toHaveBeenCalled();
    expect(readFileSync(CONFIG_PATH, "utf8")).toBe(before);
  });

  it("leaves cfg.models untouched while row.models is NULL (never configured)", async () => {
    const cfg = loadConfig();
    cfg.models = { builder: "claude-sonnet-4-6" };
    writeConfig(cfg);
    vi.mocked(writeConfig).mockClear();

    const changed = await syncConfigFromSettingsRow();
    expect(changed).toBe(false);
    expect(writeConfig).not.toHaveBeenCalled();
    const written = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FridayConfig;
    expect(written.models).toEqual({ builder: "claude-sonnet-4-6" });
  });

  it("clearing the last per-role override via the UI path deletes cfg.models (set → clear interleaving)", async () => {
    // The dashboard picker emits the whole replacement map on every
    // change and `{}` once the final override is removed (NOT null —
    // NULL means "never configured" and is preserved above). Walk the
    // exact interleaving the UI produces: set an override, then clear
    // it, asserting config.json converges on no `models` key at all.
    const db = getDb();
    await db
      .update(schema.settings)
      .set({ models: { builder: "claude-sonnet-4-6" }, updatedAt: new Date() });
    // Prime the file with NO models key — config.json persists across
    // tests in this file (per-worker tmpdir) and the NULL test above
    // leaves the same map behind, which would make the set step a no-op.
    const primed = loadConfig();
    delete primed.models;
    writeConfig(primed);
    vi.mocked(writeConfig).mockClear();

    expect(await syncConfigFromSettingsRow()).toBe(true);
    let written = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FridayConfig;
    expect(written.models).toEqual({ builder: "claude-sonnet-4-6" });

    // User selects "Use default" on the last overridden role → the
    // picker patches `models: {}` → the mutator writes `{}` to the row.
    await db.update(schema.settings).set({ models: {}, updatedAt: new Date() });

    expect(await syncConfigFromSettingsRow()).toBe(true);
    expect(writeConfig).toHaveBeenCalledTimes(2);
    written = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FridayConfig;
    expect("models" in written).toBe(false);

    // Idempotent: the row still holds `{}`; the cleared file must not
    // be rewritten on the next NOTIFY.
    expect(await syncConfigFromSettingsRow()).toBe(false);
    expect(writeConfig).toHaveBeenCalledTimes(2);
  });

  it("clearing the last evolve-task override deletes cfg.evolve.models but preserves sibling evolve keys", async () => {
    const db = getDb();
    await db
      .update(schema.settings)
      .set({ evolveModels: { enrich: "claude-sonnet-4-6" }, updatedAt: new Date() });
    const cfg = loadConfig();
    // A sibling evolve setting that must survive the clear — the listener
    // owns only the `models` slot inside `evolve`.
    cfg.evolve = { autoSpawnTriageHelpers: true };
    writeConfig(cfg);
    vi.mocked(writeConfig).mockClear();

    expect(await syncConfigFromSettingsRow()).toBe(true);
    let written = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FridayConfig;
    expect(written.evolve).toEqual({
      autoSpawnTriageHelpers: true,
      models: { enrich: "claude-sonnet-4-6" },
    });

    await db.update(schema.settings).set({ evolveModels: {}, updatedAt: new Date() });

    expect(await syncConfigFromSettingsRow()).toBe(true);
    expect(writeConfig).toHaveBeenCalledTimes(2);
    written = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FridayConfig;
    expect(written.evolve).toEqual({ autoSpawnTriageHelpers: true });

    expect(await syncConfigFromSettingsRow()).toBe(false);
    expect(writeConfig).toHaveBeenCalledTimes(2);
  });
});

describe("FRI-16 AC #22b: legacy Haiku id coercion on listener read", () => {
  it("a stored bare claude-haiku-4-5 rewrites config.json with the dated id on the first pass, then no-ops", async () => {
    const db = getDb();
    await db.update(schema.settings).set({ model: "claude-haiku-4-5", updatedAt: new Date() });

    // Prime the file at a non-Haiku model so the coercion write is
    // unambiguous regardless of what earlier tests left in config.json.
    const cfg = loadConfig();
    cfg.model = "claude-opus-4-7";
    writeConfig(cfg);
    vi.mocked(writeConfig).mockClear();

    const changed = await syncConfigFromSettingsRow();
    expect(changed).toBe(true);
    expect(writeConfig).toHaveBeenCalledTimes(1);
    const written = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FridayConfig;
    expect(written.model).toBe("claude-haiku-4-5-20251001");

    // Idempotent: the row still holds the bare id, but the coerced
    // comparison now matches the file — no second rewrite.
    const changedAgain = await syncConfigFromSettingsRow();
    expect(changedAgain).toBe(false);
    expect(writeConfig).toHaveBeenCalledTimes(1);
  });

  it("a dated id is a coercion no-op (writes once for the model change, not for the coercion)", async () => {
    const db = getDb();
    await db
      .update(schema.settings)
      .set({ model: "claude-haiku-4-5-20251001", updatedAt: new Date() });

    // Prime the file at a non-Haiku model — config.json persists across
    // tests in this file (the tmpdir is per-worker), so the previous
    // coercion test may have already left the dated id in place.
    const cfg = loadConfig();
    cfg.model = "claude-opus-4-7";
    writeConfig(cfg);
    vi.mocked(writeConfig).mockClear();

    const changed = await syncConfigFromSettingsRow();
    expect(changed).toBe(true);
    const written = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FridayConfig;
    expect(written.model).toBe("claude-haiku-4-5-20251001");

    const changedAgain = await syncConfigFromSettingsRow();
    expect(changedAgain).toBe(false);
    expect(writeConfig).toHaveBeenCalledTimes(1);
  });
});
