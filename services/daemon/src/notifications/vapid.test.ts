/**
 * FRI-142 / ADR-048 — VAPID keypair persistence (Harden-VAPID stage).
 *
 * The keypair now lives in the SERVER-ONLY `web_push_vapid` Postgres table (NOT
 * a `~/.friday/vapid.json` file), so it rides the same `pg_dump` as
 * `push_subscriptions`. The load-bearing invariant: the keypair is generated
 * EXACTLY ONCE for the life of the database and never overwritten — a
 * regeneration would invalidate every existing subscription (the browser
 * subscribed against the OLD public key, so the push service returns 410/404
 * for all of them).
 *
 * Tested at the layer the bug lives in: a real per-file `friday_test_*` scratch
 * Postgres (createTestDb applies the full migration chain incl. 0041, so the
 * real `web_push_vapid` table + its singleton CHECK are in play), with the REAL
 * daemon `getDb()` / Drizzle `INSERT … ON CONFLICT DO NOTHING` path. Only
 * `web-push.generateVAPIDKeys` is mocked — to a deterministic, call-counted,
 * UNIQUE-per-call keypair so a test can prove (a) generated-once, (b) which
 * candidate actually persisted under the race, and (c) no regeneration on the
 * second call. `setVapidDetails` is mocked to assert the configure latch.
 *
 * Skipped when Postgres is unreachable (mirrors store.pg.test.ts).
 */

import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, findPgIsReady, getPool, type TestDbHandle } from "@friday/shared";

// A monotonic counter so every generateVAPIDKeys() call yields a DISTINCT
// keypair — that lets us assert "the same keypair came back" (no regen) and
// detect a spurious second generation. Hoisted so the vi.mock factory sees it.
const gen = vi.hoisted(() => ({ count: 0 }));
const generateSpy = vi.fn(() => {
  gen.count += 1;
  return { publicKey: `PUB-${gen.count}`, privateKey: `PRIV-${gen.count}` };
});
const setVapidDetailsSpy = vi.fn();

vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: () => generateSpy(),
    setVapidDetails: (...args: unknown[]) => setVapidDetailsSpy(...args),
    sendNotification: vi.fn(),
  },
}));

vi.mock("../log.js", () => ({ logger: { log: vi.fn() } }));

function pgReachable(): boolean {
  return (
    spawnSync(findPgIsReady(), ["-h", "localhost", "-p", "5432"], { encoding: "utf8" }).status === 0
  );
}

const skip = !pgReachable();

/** Direct COUNT(*) over web_push_vapid — the structural single-row invariant. */
async function vapidRowCount(): Promise<number> {
  const r = await getPool().query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM web_push_vapid`);
  return Number(r.rows[0]!.n);
}

describe.skipIf(skip)("FRI-142 ensureVapidKeys (scratch PG, server-only table)", () => {
  let handle: TestDbHandle;
  // Imported AFTER createTestDb so the @friday/shared client binds to the
  // scratch DATABASE_URL (the getDb() pool caches its URL on first use).
  let vapid: typeof import("./vapid.js");

  beforeAll(async () => {
    handle = await createTestDb({ label: "vapid" });
    vapid = await import("./vapid.js");
  });

  afterAll(async () => {
    await handle.drop();
  });

  beforeEach(async () => {
    await handle.truncate();
    gen.count = 0;
    generateSpy.mockClear();
    setVapidDetailsSpy.mockClear();
    vapid.__resetVapidCacheForTest();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("generates + persists a keypair on first call; returns the SAME keypair on the second with row count staying 1 (no regenerate)", async () => {
    const first = await vapid.ensureVapidKeys();
    expect(first).toEqual({ publicKey: "PUB-1", privateKey: "PRIV-1" });
    expect(await vapidRowCount()).toBe(1);

    // Clear the in-process cache so the SECOND call must hit Postgres again —
    // proving persistence + idempotence are DB-backed, not just memo-cached.
    vapid.__resetVapidCacheForTest();

    const second = await vapid.ensureVapidKeys();
    expect(second).toEqual(first); // byte-identical — the SAME persisted keypair
    expect(await vapidRowCount()).toBe(1); // still exactly one row — no regen
  });

  it("two CONCURRENT first-calls converge on ONE keypair and ONE row (ON CONFLICT DO NOTHING)", async () => {
    // Both calls race the INSERT; the loser's candidate is dropped by
    // ON CONFLICT, both SELECT back the single winning row.
    const [a, b] = await Promise.all([vapid.ensureVapidKeys(), vapid.ensureVapidKeys()]);

    // (a) and (b) MUST be byte-identical — one keypair, not two.
    expect(a).toEqual(b);
    // The persisted keypair is one of the two generated candidates.
    expect(["PUB-1", "PUB-2"]).toContain(a.publicKey);
    expect(a.privateKey).toBe(a.publicKey.replace("PUB", "PRIV"));
    // Exactly ONE row survived the race.
    expect(await vapidRowCount()).toBe(1);
  });

  it("the singleton CHECK + PK make a second row physically impossible", async () => {
    await vapid.ensureVapidKeys();
    // A direct attempt to seed a second row must be rejected: the PK collides on
    // 'singleton', and any other id is rejected by the CHECK.
    await expect(
      getPool().query(
        `INSERT INTO web_push_vapid (id, public_key, private_key, created_at)
         VALUES ('other', 'X', 'Y', now())`,
      ),
    ).rejects.toThrow(); // web_push_vapid_singleton_check
    await expect(
      getPool().query(
        `INSERT INTO web_push_vapid (id, public_key, private_key, created_at)
         VALUES ('singleton', 'X', 'Y', now())`,
      ),
    ).rejects.toThrow(); // duplicate PK
    expect(await vapidRowCount()).toBe(1);
  });

  it("getVapidPublicKey returns the PUBLIC key only (never the private key)", async () => {
    const pub = await vapid.getVapidPublicKey();
    expect(pub).toBe("PUB-1");
    // The returned value is the public half — assert it is NOT the private one.
    expect(pub).not.toBe("PRIV-1");
  });

  it("ensureVapidConfigured calls setVapidDetails exactly once with (subject, pub, priv), idempotent", async () => {
    await vapid.ensureVapidConfigured("mailto:test@example.com");
    await vapid.ensureVapidConfigured("mailto:test@example.com");

    expect(setVapidDetailsSpy).toHaveBeenCalledTimes(1);
    expect(setVapidDetailsSpy).toHaveBeenCalledWith("mailto:test@example.com", "PUB-1", "PRIV-1");
  });

  it("ensureVapidConfigured defaults the subject when none is provided", async () => {
    await vapid.ensureVapidConfigured();
    expect(setVapidDetailsSpy).toHaveBeenCalledWith("mailto:friday@localhost", "PUB-1", "PRIV-1");
  });
});
