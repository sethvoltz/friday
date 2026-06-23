// FRI-142 (ADR-048) — Foundation contract test.
//
// Pins the shared schema/sync invariants downstream daemon + dashboard stages
// depend on, so a regression that flips a column's nullability, leaks a
// server-only table into Zero, or mis-shapes the notify_policy/DND columns
// fails HERE rather than as a SchemaVersionNotSupported reload loop in prod or
// a phantom type error in a downstream stage.
//
// Pure import-and-introspect (no DB connection): asserts on the Drizzle
// `getTableColumns(...)` descriptors and the Zero `createSchema` column records.
// This is the static-string + column-shape contract AC10 (toast/push storageless
// invariants) and AC8 (raw_text nullable) gate on at the schema layer.

import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { inboxItems, pushSubscriptions, settings, webPushVapid } from "./schema.js";
import { SYNC_TABLES } from "./pg-provision.js";
import { schema as zeroSchema } from "../sync/schema.js";

describe("FRI-142 push_subscriptions (server-only — the apikey precedent)", () => {
  it("exposes exactly the ADR-048 column set", () => {
    const cols = Object.values(getTableColumns(pushSubscriptions))
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(
      [
        "id",
        "endpoint",
        "p256dh",
        "auth",
        "user_id",
        "device_id",
        "created_at",
        "last_seen_at",
      ].sort(),
    );
  });

  it("endpoint is NOT NULL and UNIQUE (the stale-cleanup key)", () => {
    const endpoint = getTableColumns(pushSubscriptions).endpoint;
    expect(endpoint.name).toBe("endpoint");
    expect(endpoint.notNull).toBe(true);
    expect(endpoint.isUnique).toBe(true);
  });

  it("p256dh / auth / user_id are NOT NULL; device_id is nullable (FK)", () => {
    const c = getTableColumns(pushSubscriptions);
    expect(c.p256dh.notNull).toBe(true);
    expect(c.auth.notNull).toBe(true);
    expect(c.userId.notNull).toBe(true);
    expect(c.deviceId.name).toBe("device_id");
    expect(c.deviceId.notNull).toBe(false);
  });

  it("created_at / last_seen_at are NOT NULL timestamptz", () => {
    const c = getTableColumns(pushSubscriptions);
    expect(c.createdAt.notNull).toBe(true);
    expect(c.lastSeenAt.notNull).toBe(true);
  });

  it("is ABSENT from SYNC_TABLES (server-only — never replicated)", () => {
    expect(SYNC_TABLES).not.toContain("push_subscriptions");
  });

  it("is ABSENT from the Zero sync schema's table set", () => {
    expect(Object.keys(zeroSchema.tables)).not.toContain("push_subscriptions");
  });
});

describe("FRI-142 web_push_vapid (server-only — the private key must NEVER replicate)", () => {
  it("exposes exactly the ADR-048 column set", () => {
    const cols = Object.values(getTableColumns(webPushVapid))
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(["id", "public_key", "private_key", "created_at"].sort());
  });

  it("public_key / private_key / created_at are NOT NULL; id is the singleton PK", () => {
    const c = getTableColumns(webPushVapid);
    expect(c.publicKey.name).toBe("public_key");
    expect(c.publicKey.notNull).toBe(true);
    expect(c.privateKey.name).toBe("private_key");
    expect(c.privateKey.notNull).toBe(true);
    expect(c.createdAt.name).toBe("created_at");
    expect(c.createdAt.notNull).toBe(true);
    expect(c.id.primary).toBe(true);
  });

  it("is ABSENT from SYNC_TABLES (server-only — the private key never replicates)", () => {
    expect(SYNC_TABLES).not.toContain("web_push_vapid");
  });

  it("is ABSENT from the Zero sync schema's table set (the apikey precedent)", () => {
    expect(Object.keys(zeroSchema.tables)).not.toContain("web_push_vapid");
  });
});

describe("FRI-142 settings — notify_policy + DND columns", () => {
  it("notify_policy is a nullable jsonb column", () => {
    const c = getTableColumns(settings).notifyPolicy;
    expect(c.name).toBe("notify_policy");
    expect(c.columnType).toBe("PgJsonb");
    expect(c.notNull).toBe(false);
  });

  it("dnd_start / dnd_end are nullable text columns (HH:MM, NULL ⇒ no DND)", () => {
    const c = getTableColumns(settings);
    expect(c.dndStart.name).toBe("dnd_start");
    expect(c.dndStart.columnType).toBe("PgText");
    expect(c.dndStart.notNull).toBe(false);
    expect(c.dndEnd.name).toBe("dnd_end");
    expect(c.dndEnd.columnType).toBe("PgText");
    expect(c.dndEnd.notNull).toBe(false);
  });

  it("critical_bypass_dnd is NOT NULL boolean defaulting to true", () => {
    const c = getTableColumns(settings).criticalBypassDnd;
    expect(c.name).toBe("critical_bypass_dnd");
    expect(c.columnType).toBe("PgBoolean");
    expect(c.notNull).toBe(true);
    expect(c.hasDefault).toBe(true);
  });

  it("settings IS replicated — the new columns ride the existing entry", () => {
    // settings is Zero-replicated (already in SYNC_TABLES); the new columns
    // MUST also be projected by the Zero schema or the dashboard reload-loops
    // (CLAUDE.md gotcha #2). No SYNC_TABLES edit was needed (settings is listed).
    expect(SYNC_TABLES).toContain("settings");
    const zc = zeroSchema.tables.settings.columns as Record<
      string,
      { type: string; optional: boolean }
    >;
    expect(zc.notify_policy).toMatchObject({ type: "json", optional: true });
    expect(zc.dnd_start).toMatchObject({ type: "string", optional: true });
    expect(zc.dnd_end).toMatchObject({ type: "string", optional: true });
    // NOT NULL default-true in PG ⇒ Zero always projects a value ⇒ non-optional.
    expect(zc.critical_bypass_dnd).toMatchObject({ type: "boolean", optional: false });
  });
});

describe("FRI-142 inbox_items.raw_text → nullable (Layer 3 decouple)", () => {
  it("raw_text is now a nullable text column (non-Intake producers write NULL)", () => {
    const c = getTableColumns(inboxItems).rawText;
    expect(c.name).toBe("raw_text");
    expect(c.columnType).toBe("PgText");
    expect(c.notNull).toBe(false);
  });
});

describe("FRI-142 AC10 — toast/notifications are storageless (no row, no sync)", () => {
  it("SYNC_TABLES contains no toast/notifications/push_subscriptions/web_push_vapid string", () => {
    for (const forbidden of ["toast", "notifications", "push_subscriptions", "web_push_vapid"]) {
      expect(SYNC_TABLES).not.toContain(forbidden);
    }
  });

  it("the Zero schema's table set contains no toast/notifications/push_subscriptions/web_push_vapid", () => {
    const tables = Object.keys(zeroSchema.tables);
    for (const forbidden of ["toast", "notifications", "push_subscriptions", "web_push_vapid"]) {
      expect(tables).not.toContain(forbidden);
    }
  });

  it("there is no `notifications` table in the Drizzle schema (storageless v1)", async () => {
    const drizzle = await import("./schema.js");
    expect((drizzle as Record<string, unknown>).notifications).toBeUndefined();
  });
});
