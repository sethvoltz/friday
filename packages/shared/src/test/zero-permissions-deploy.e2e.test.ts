/**
 * FRI-129 — verifies the test sync-harness deploys Zero's row-level
 * permissions to the scratch upstream DB before spawning zero-cache.
 *
 * Covers two acceptance criteria that are independent of the browser:
 *
 *   - AC #2 (direct probe of the deploy step): after a non-skip
 *     `spawnTestSyncEnv`, the scratch DB's `zero.permissions` row is
 *     deployed with the full permissions set — non-NULL, contains the
 *     `agents` table key, and covers all 14 tables.
 *
 *   - AC #5, half 1 (deploy runs exactly once per non-skip boot): the
 *     `zeroDeployInvocations` counter is exactly 1 after a single
 *     non-skip boot. The `=== 0` for a `skipZeroCache` boot is its own
 *     file (`zero-permissions-skip.e2e.test.ts`) because the harness
 *     docstring requires one env per file — a second boot here would
 *     orphan the first env's global pg pool and surface a teardown
 *     FATAL as an unhandled error.
 *
 * AC #1 (seeded rows materialize in the browser Zero client) lives in
 * the Playwright suite at `services/dashboard/e2e/zero-permissions.spec.ts`
 * because Zero's Node client closes WS with code 1006 against the
 * harness (see the sync-harness docstring).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { spawnTestSyncEnv, zeroDeployInvocations, type SyncEnv } from "./sync-harness.js";

const TEST_TIMEOUT_MS = 90_000;

let env: SyncEnv;
// Count of deploy invocations attributable to the non-skip boot below.
let nonSkipBootInvocations = 0;

beforeAll(async () => {
  // Reset the counter immediately before the boot we measure so AC #5's
  // `=== 1` assertion reflects this boot alone (not any prior file's).
  zeroDeployInvocations.count = 0;
  env = await spawnTestSyncEnv({ label: "zero_perms_deploy" });
  nonSkipBootInvocations = zeroDeployInvocations.count;
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await env.cleanup();
}, TEST_TIMEOUT_MS);

describe("FRI-129: sync-harness deploys Zero permissions", () => {
  it(
    "AC#2: deploys the full permissions set to zero.permissions (non-NULL, agents key, 14 tables)",
    async () => {
      const c = new Client({ connectionString: env.databaseUrl });
      await c.connect();
      try {
        const notNull = await c.query<{ not_null: boolean }>(
          `SELECT (permissions IS NOT NULL) AS not_null FROM zero.permissions`,
        );
        expect(notNull.rows).toHaveLength(1);
        expect(notNull.rows[0]!.not_null).toBe(true);

        const hasAgents = await c.query<{ has_agents: boolean }>(
          `SELECT ((permissions->'tables') ? 'agents') AS has_agents FROM zero.permissions`,
        );
        expect(hasAgents.rows[0]!.has_agents).toBe(true);

        const keyCount = await c.query<{ key_count: string }>(
          `SELECT count(*)::text AS key_count
             FROM jsonb_object_keys((SELECT permissions->'tables' FROM zero.permissions))`,
        );
        // node-postgres returns count() as a string; compare numerically.
        expect(Number(keyCount.rows[0]!.key_count)).toBe(14);
      } finally {
        await c.end();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it("AC#5: deploy ran exactly once for the non-skip boot", () => {
    expect(nonSkipBootInvocations).toBe(1);
  });
});
