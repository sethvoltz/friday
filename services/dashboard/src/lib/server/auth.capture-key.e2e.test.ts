/**
 * FRI-171 (ADR-047) — REAL apiKey-plugin round-trip against a real Postgres
 * (review finding #1). Every other capture-key test mocks `verifyApiKey` /
 * `createApiKey` or the drizzle adapter, so NONE of them would catch a
 * column-name / permission-serialization mismatch between the `apikey`
 * migration (0039) + the `apikeys` pgTable and what the 1.6.9 BetterAuth
 * drizzle adapter actually looks up (`referenceId`/`configId`/camelCase). Such
 * a mismatch makes `verifyApiKey` silently return `{valid:false}` for every
 * Capture — a 401 on every real Watch/quick-add POST — with zero unit coverage.
 *
 * This is the ONLY test that exercises the migration ↔ plugin contract:
 *   1. `createTestDb()` runs the full migration chain (incl. 0039 apikey) on a
 *      throwaway `friday_test_*` DB (NEVER the host `friday` DB).
 *   2. A REAL `betterAuth` instance with the SAME apiKey-plugin config as
 *      production (`enableSessionForAPIKeys:false`, `capture:["write"]`) is
 *      constructed against that DB.
 *   3. `createApiKey({ permissions:{capture:["write"]} })` then
 *      `verifyApiKey({ key, permissions:{capture:["write"]} })` must return
 *      `{valid:true}` — proving the columns line up and the scope round-trips.
 *   4. The `session` table is asserted EMPTY — AC4's "a verified Capture key
 *      mints NO session" as a real round-trip, not just a config assertion.
 *
 * `.e2e.test.ts` so it runs in `pnpm test:e2e` (real PG), not the unit suite.
 * Skipped when Postgres is unreachable.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { apiKey } from "@better-auth/api-key";
import {
  createTestDb,
  newTestClient,
  getDb,
  schema,
  findPgIsReady,
  type TestDbHandle,
} from "@friday/shared";
import type pgPkg from "pg";

function pgReachable(): boolean {
  return (
    spawnSync(findPgIsReady(), ["-h", "localhost", "-p", "5432"], { encoding: "utf8" }).status === 0
  );
}

const skip = !pgReachable();

/**
 * Build a real betterAuth instance with the SAME apiKey-plugin config as
 * production (auth.ts) against the scratch DB. Defined as a factory (not
 * inline) so TypeScript infers the PRECISE instance type — including the
 * apiKey plugin's `createApiKey`/`verifyApiKey` endpoints on `auth.api`.
 * Annotating with the widened `Auth<BetterAuthOptions>` would erase them.
 *
 * We do NOT import auth.ts — it depends on `$app/environment` and runs
 * trustedOrigins/process.exit wiring at module load; the plugin↔table contract
 * is what we're testing.
 */
function makeAuth() {
  return betterAuth({
    database: drizzleAdapter(getDb(), { provider: "pg", schema, usePlural: true }),
    baseURL: "http://localhost:7615",
    secret: "test-secret-capture-key-e2e",
    emailAndPassword: { enabled: true },
    plugins: [
      apiKey({
        enableSessionForAPIKeys: false,
        permissions: { defaultPermissions: { capture: ["write"] } },
        apiKeyHeaders: "x-api-key",
      }),
    ],
  });
}

describe.skipIf(skip)("apiKey plugin ↔ apikey migration round-trip (real PG)", () => {
  let handle: TestDbHandle;
  let client: pgPkg.Client;
  let auth: ReturnType<typeof makeAuth>;
  let userId: string;

  beforeAll(async () => {
    // Applies the full chain — incl. 0039 (apikey) — to a throwaway DB and
    // rebinds getDb() to it. Reaching afterAll proves the migration applied.
    handle = await createTestDb({ label: "capture_key" });
    client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();

    auth = makeAuth();

    // Seed the sole account directly (public sign-up is disabled in prod; the
    // owner is the key's `referenceId`).
    userId = randomUUID();
    const now = new Date();
    await client.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, false, $4, $4)`,
      [userId, "Seth", `seth+${userId}@example.com`, now],
    );
  }, 120_000);

  afterAll(async () => {
    await client.end();
    await handle.drop();
  }, 120_000);

  it("mints a capture:[write] key whose columns the adapter persists + reads back", async () => {
    const created = await auth.api.createApiKey({
      body: { userId, name: "watch", prefix: "fcap_", permissions: { capture: ["write"] } },
    });
    expect(typeof created.key).toBe("string");
    expect(created.key.length).toBeGreaterThan(0);

    // The row landed in the apikey table with the owner + scope (proves the
    // migration's column names match the adapter's writes).
    const row = await client.query<{ reference_id: string; permissions: string | null }>(
      `SELECT "referenceId" AS reference_id, permissions FROM apikey WHERE id = $1`,
      [created.id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.reference_id).toBe(userId);
    expect(JSON.parse(row.rows[0]!.permissions ?? "{}")).toEqual({ capture: ["write"] });
  });

  it("verifies a freshly-minted capture key for the capture:[write] scope", async () => {
    const created = await auth.api.createApiKey({
      body: { userId, name: "verify-me", permissions: { capture: ["write"] } },
    });

    const verified = await auth.api.verifyApiKey({
      body: { key: created.key, permissions: { capture: ["write"] } },
    });
    // The contract finding #1 guards: a column/scope mismatch would make this
    // silently `{ valid: false }` (→ 401 on every real Capture).
    expect(verified.valid).toBe(true);
  });

  it("a verified Capture key mints NO session (AC4 as a real round-trip)", async () => {
    const before = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM session`);
    expect(before.rows[0]!.n).toBe("0");

    const created = await auth.api.createApiKey({
      body: { userId, name: "no-session", permissions: { capture: ["write"] } },
    });
    const verified = await auth.api.verifyApiKey({
      body: { key: created.key, permissions: { capture: ["write"] } },
    });
    expect(verified.valid).toBe(true);

    // `enableSessionForAPIKeys: false` — verifying a key must NOT create a
    // session row. (A flip to true would populate this table.)
    const after = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM session`);
    expect(after.rows[0]!.n).toBe("0");
  });

  it("rejects a key whose scope does not grant capture:[write]", async () => {
    // A key minted with a DIFFERENT explicit scope must not verify against
    // capture:[write] — this exercises the permission-serialization /
    // comparison path the capture route relies on for its 401. (Note: a key
    // minted with NO explicit permissions inherits the plugin's
    // `defaultPermissions: { capture: ["write"] }`, so the mismatch must be an
    // explicit non-capture scope.)
    const created = await auth.api.createApiKey({
      body: { userId, name: "other-scope", permissions: { other: ["read"] } },
    });
    const verified = await auth.api.verifyApiKey({
      body: { key: created.key, permissions: { capture: ["write"] } },
    });
    expect(verified.valid).toBe(false);
  });
});
