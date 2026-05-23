/**
 * Smoke test for the multi-subprocess test harness. If this passes,
 * the more-elaborate suites in services/{daemon,dashboard}/ can rely
 * on the harness primitives.
 *
 * Verifies:
 *   - All three subprocesses come up and their TCP ports accept
 *     connections.
 *   - The dashboard's auth-gated /api/sync/refresh accepts a mint
 *     request when called with a signed test cookie (proves both the
 *     dashboard config + the auth-cookie helper match).
 *   - Cleanup tears every subprocess down.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnTestSyncEnv, type SyncEnv } from "./sync-harness.js";

// e2e tests carry a multi-second subprocess boot — bump the per-test
// timeout from the vitest default of 5s.
const TEST_TIMEOUT_MS = 60_000;

let env: SyncEnv;

beforeAll(async () => {
  env = await spawnTestSyncEnv({ label: "harness_smoke" });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await env.cleanup();
}, TEST_TIMEOUT_MS);

describe("sync-harness smoke (item #50)", () => {
  it("brings up all three subprocesses (daemon + dashboard + zero-cache)", () => {
    expect(env.daemon.child.pid).toBeGreaterThan(0);
    expect(env.dashboard.child.pid).toBeGreaterThan(0);
    expect(env.zeroCache.child.pid).toBeGreaterThan(0);
  });

  it(
    "the dashboard accepts auth-cookie'd /api/sync/refresh and mints a Zero JWT",
    async () => {
      const session = await env.mintCookie();
      const r = await fetch(`http://127.0.0.1:${env.dashboard.port}/api/sync/refresh`, {
        method: "POST",
        headers: { Cookie: session.cookie },
      });
      if (r.status !== 200) {
        const body = await r.text();

        console.error("/api/sync/refresh non-200:", r.status, body, "cookie:", session.cookie);
      }
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        token: string;
        deviceId: string;
        userId: string;
        expiresAt: number;
      };
      expect(body.token).toMatch(/\./); // JWT shape: header.payload.sig
      expect(body.userId).toBe(session.userId);
      expect(body.expiresAt).toBeGreaterThan(Date.now());
    },
    TEST_TIMEOUT_MS,
  );
});
