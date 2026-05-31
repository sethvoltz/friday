/**
 * Playwright globalSetup: bring up the full sync env (daemon +
 * dashboard + zero-cache + scratch DB) and stash the connection
 * details in `e2e/.env.json` for the test bodies to read.
 *
 * Why a JSON file vs. process.env: Playwright runs tests in worker
 * subprocesses that don't inherit globalSetup's runtime state. The
 * file is the cleanest cross-process handoff.
 *
 * `globalSetup` returns a cleanup function (Playwright supported,
 * docs: https://playwright.dev/docs/test-global-setup-teardown).
 * Returning the cleanup avoids the global-state hack of stashing
 * the env on a module binding for `globalTeardown` to fetch.
 *
 * Also mints a session cookie for a fixed test user so the test
 * bodies can `context.addCookies(...)` and start authenticated. The
 * user row + session row live in the scratch DB and disappear at
 * teardown.
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnTestSyncEnv, type SyncEnv } from "@friday/shared/test/sync-harness";

export function envPath(): string {
  return join(import.meta.dirname, ".env.json");
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const env: SyncEnv = await spawnTestSyncEnv({ label: "playwright" });
  const session = await env.mintCookie({
    email: "playwright@example.com",
    name: "Playwright Test User",
  });
  const envSnapshot = {
    dashboardURL: `http://127.0.0.1:${env.dashboard.port}`,
    daemonPort: env.daemon.port,
    zeroCachePort: env.zeroCache.port,
    databaseUrl: env.databaseUrl,
    cookie: session.cookie,
    userId: session.userId,
    deviceId: session.deviceId,
  };
  writeFileSync(envPath(), JSON.stringify(envSnapshot, null, 2));

  console.log(`[playwright globalSetup] env up: ${envSnapshot.dashboardURL}`);

  return async () => {
    try {
      unlinkSync(envPath());
    } catch {
      /* ignore */
    }
    // Guard with optional chaining to match the vitest e2e files: keep the
    // teardown robust to a partially-initialized env so a real boot error
    // surfaces instead of a masking `reading 'cleanup'` TypeError.
    await env?.cleanup();

    console.log("[playwright globalTeardown] env down");
  };
}
