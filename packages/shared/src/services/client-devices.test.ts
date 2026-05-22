import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "../db/test-pg.js";

let handle: TestDbHandle;
let getClientDevice: (typeof import("./client-devices.js"))["getClientDevice"];
let upsertClientDevice: (typeof import("./client-devices.js"))["upsertClientDevice"];
let listClientDevicesForUser: (typeof import("./client-devices.js"))["listClientDevicesForUser"];
let forgetClientDevice: (typeof import("./client-devices.js"))["forgetClientDevice"];
let getDb: (typeof import("../db/client.js"))["getDb"];
let schema: typeof import("../db/schema.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "client_devices" });
  ({ getClientDevice, upsertClientDevice, listClientDevicesForUser, forgetClientDevice } =
    await import("./client-devices.js"));
  ({ getDb } = await import("../db/client.js"));
  schema = await import("../db/schema.js");
  // Foreign key: client_devices.user_id has no FK in the schema (it's a
  // free string per the schema definition), so we don't need to seed
  // any `user` rows. Confirm via a query.
  void schema;
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

describe("upsertClientDevice", () => {
  it("inserts a fresh row on first sight", async () => {
    const row = await upsertClientDevice({
      deviceId: "device-1",
      userId: "user-1",
      userAgent: "Mozilla/5.0",
    });
    expect(row.deviceId).toBe("device-1");
    expect(row.userId).toBe("user-1");
    expect(row.userAgent).toBe("Mozilla/5.0");
    expect(row.firstSeenAt).toBeGreaterThan(0);
    expect(row.lastSeenAt).toBe(row.firstSeenAt);
    expect(row.lastSyncAt).toBe(row.firstSeenAt);
  });

  it("refreshes last_seen_at on subsequent upserts without rewriting first_seen_at", async () => {
    const first = await upsertClientDevice({
      deviceId: "device-2",
      userId: "user-1",
      userAgent: "browser-a",
    });
    // Sleep a couple of ms so the second timestamp is strictly later.
    await new Promise((r) => setTimeout(r, 5));
    const second = await upsertClientDevice({
      deviceId: "device-2",
      userId: "user-1",
      userAgent: "browser-a",
    });
    expect(second.firstSeenAt).toBe(first.firstSeenAt);
    expect(second.lastSeenAt).toBeGreaterThan(first.lastSeenAt);
  });

  it("updates userAgent on subsequent upserts when a non-null value is passed", async () => {
    await upsertClientDevice({
      deviceId: "device-3",
      userId: "user-1",
      userAgent: "old-browser",
    });
    const updated = await upsertClientDevice({
      deviceId: "device-3",
      userId: "user-1",
      userAgent: "new-browser",
    });
    expect(updated.userAgent).toBe("new-browser");
  });

  it("preserves prior userAgent when a subsequent upsert passes null", async () => {
    await upsertClientDevice({
      deviceId: "device-4",
      userId: "user-1",
      userAgent: "preserve-me",
    });
    const updated = await upsertClientDevice({
      deviceId: "device-4",
      userId: "user-1",
      userAgent: null,
    });
    expect(updated.userAgent).toBe("preserve-me");
  });
});

describe("getClientDevice / listClientDevicesForUser", () => {
  it("returns null for an unknown device", async () => {
    expect(await getClientDevice("nope")).toBeNull();
  });

  it("lists exactly the devices belonging to a user", async () => {
    await upsertClientDevice({
      deviceId: "d1",
      userId: "alice",
      userAgent: "browser",
    });
    await upsertClientDevice({
      deviceId: "d2",
      userId: "alice",
      userAgent: "browser",
    });
    await upsertClientDevice({
      deviceId: "d3",
      userId: "bob",
      userAgent: "browser",
    });
    const alice = await listClientDevicesForUser("alice");
    expect(alice.map((d) => d.deviceId).sort()).toEqual(["d1", "d2"]);
    const bob = await listClientDevicesForUser("bob");
    expect(bob.map((d) => d.deviceId)).toEqual(["d3"]);
  });
});

describe("forgetClientDevice", () => {
  it("hard-deletes the row and returns true on success", async () => {
    await upsertClientDevice({
      deviceId: "to-forget",
      userId: "user-1",
      userAgent: null,
    });
    const ok = await forgetClientDevice("to-forget", "user-1");
    expect(ok).toBe(true);
    expect(await getClientDevice("to-forget")).toBeNull();
  });

  it("returns false when the device is already gone", async () => {
    const ok = await forgetClientDevice("never-existed", "user-1");
    expect(ok).toBe(false);
  });
});
