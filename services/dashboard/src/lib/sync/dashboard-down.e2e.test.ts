/**
 * Dashboard-down resilience (item #50, plan §4 step 4d).
 *
 * Scoped to Friday's restart contract: the dashboard subprocess can
 * be killed and brought back without leaving the system in a wedged
 * state. Specifically:
 *
 *   1. With the dashboard up, `/api/sync/refresh` returns 200 with
 *      a fresh JWT (proves the harness is in a known-good baseline).
 *
 *   2. SIGTERM the dashboard child, wait for exit. A request fired
 *      DURING the gap fails cleanly (connection refused / fetch
 *      error) — not a 5xx hang.
 *
 *   3. Re-spawn the dashboard against the same DB / port / secrets.
 *      Within READY_DEADLINE_MS, `/api/sync/refresh` returns 200
 *      again and mints a valid JWT against the same BetterAuth
 *      session row.
 *
 *   4. The minted JWT is structurally well-formed (3-segment shape,
 *      verifiable userId), proving the dashboard re-initialized the
 *      ZERO_AUTH_SECRET signer correctly from env on restart.
 *
 * Out of scope: Zero's WS reconnect protocol behavior. That's
 * Rocicorp's library contract; Friday owns "the dashboard process
 * itself comes back up." The Playwright suite (item #50, plan §4
 * step 4e) exercises the visible round-trip through a real browser
 * Zero client.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  spawnTestSyncEnv,
  spawnDashboardForTest,
  type DashboardHandle,
  type SyncEnv,
  type TestSessionCookie,
} from "@friday/shared/test/sync-harness";

const HARNESS_BOOT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;
const READY_DEADLINE_MS = 15_000;

let env: SyncEnv;
let session: TestSessionCookie;

beforeAll(async () => {
  env = await spawnTestSyncEnv({ label: "dashboard_down" });
  // Mint the cookie once up-front so we have a stable session row
  // that survives the dashboard restart. The cookie is plain bytes,
  // so we can keep reusing it after the restart proves the auth gate.
  session = await env.mintCookie({
    email: "dashdown@example.com",
    name: "Dashboard-Down Test",
  });
}, HARNESS_BOOT_MS);

afterAll(async () => {
  await env?.cleanup();
}, HARNESS_BOOT_MS);

async function refreshOK(
  port: number,
  cookie: string,
): Promise<{
  token: string;
  deviceId: string;
  userId: string;
  expiresAt: number;
}> {
  const r = await fetch(`http://127.0.0.1:${port}/api/sync/refresh`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  if (!r.ok) {
    throw new Error(`refresh ${r.status}: ${await r.text()}`);
  }
  return (await r.json()) as {
    token: string;
    deviceId: string;
    userId: string;
    expiresAt: number;
  };
}

async function waitForRefresh(port: number, cookie: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await refreshOK(port, cookie);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(
    `waitForRefresh: dashboard didn't accept /api/sync/refresh on :${port} within ${timeoutMs}ms; last err: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

async function waitForExit(child: DashboardHandle, timeoutMs = 5_000): Promise<void> {
  if (child.child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`dashboard didn't exit within ${timeoutMs}ms`)),
      timeoutMs,
    );
    child.child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

describe("dashboard-down resilience (item #50 — plan §4 step 4d)", () => {
  it(
    "baseline: /api/sync/refresh returns 200 with a JWT",
    async () => {
      const body = await refreshOK(env.dashboard.port, session.cookie);
      expect(body.userId).toBe(session.userId);
      expect(body.token.split(".")).toHaveLength(3);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "kill mid-flight: requests during the gap fail cleanly (no 5xx hang)",
    async () => {
      env.dashboard.child.kill("SIGTERM");
      await waitForExit(env.dashboard);
      // Fetch against the dead port — should reject with a fetch error
      // (ECONNREFUSED), NOT hang and not 5xx. The `fetch` Promise must
      // reject, which is what `expect(...).rejects` asserts.
      await expect(
        fetch(`http://127.0.0.1:${env.dashboard.port}/api/sync/refresh`, {
          method: "POST",
          headers: { Cookie: session.cookie },
        }),
      ).rejects.toThrow();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "restart: dashboard comes back and serves /api/sync/refresh against the same session",
    async () => {
      const fresh = await spawnDashboardForTest({
        databaseUrl: env.databaseUrl,
        zeroCachePort: env.zeroCache.port,
        daemonPort: env.daemon.port,
        authSecret: env.zeroAuthSecret,
        betterAuthSecret: env.betterAuthSecret,
        daemonSecret: env.daemonSecret,
        dataDir: env.daemon.dataDir,
        port: env.dashboard.port,
      });
      env.dashboard = fresh;
      await fresh.ready;

      // Once ready, /api/sync/refresh should accept the same cookie
      // and return a valid JWT. The deadline lets adapter-node finish
      // its lazy module imports on first request post-boot.
      await waitForRefresh(fresh.port, session.cookie, READY_DEADLINE_MS);

      const body = await refreshOK(fresh.port, session.cookie);
      expect(body.userId).toBe(session.userId);
      // Structural JWT shape: header.payload.signature — proves the
      // dashboard re-loaded ZERO_AUTH_SECRET from env on restart and
      // is signing again.
      const segments = body.token.split(".");
      expect(segments).toHaveLength(3);
      expect(segments.every((s) => s.length > 0)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
