/**
 * FRI-129 — AC #5, half 2: the Zero-permissions deploy runs ZERO times
 * for a `skipZeroCache: true` boot.
 *
 * Split into its own file (vs. the non-skip count in
 * `zero-permissions-deploy.e2e.test.ts`) because the harness docstring
 * mandates one `spawnTestSyncEnv` per file: a second boot in the same
 * file orphans the first env's global pg pool, and the first env's
 * teardown then emits a 57P01 FATAL on the orphaned connection that
 * vitest reports as an unhandled error.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnTestSyncEnv, zeroDeployInvocations, type SyncEnv } from "./sync-harness.js";

const TEST_TIMEOUT_MS = 90_000;

// This boot skips zero-cache/daemon/dashboard, so its real work is just the
// scratch-DB create, but the boot hook still must clear the harness's
// worst-case internal ceiling — a per-call third arg OVERRIDES the
// config-level hookTimeout (180s). Keep it in lockstep with the sibling e2e
// files' 180s convention so the timeout invariant (every boot hook >= the
// harness ceiling) holds uniformly across every *.e2e.test.ts.
const HARNESS_BOOT_MS = 180_000;

let env: SyncEnv;
let skipBootInvocations = 0;

beforeAll(async () => {
  // Reset immediately before the measured boot so the assertion
  // reflects this boot alone.
  zeroDeployInvocations.count = 0;
  env = await spawnTestSyncEnv({
    label: "zero_perms_skip",
    skipZeroCache: true,
    skipDaemon: true,
    skipDashboard: true,
  });
  skipBootInvocations = zeroDeployInvocations.count;
}, HARNESS_BOOT_MS);

afterAll(async () => {
  // Guard with optional chaining so a failed/killed boot surfaces its real
  // error instead of a masking `reading 'cleanup'` TypeError on undefined env.
  await env?.cleanup();
}, HARNESS_BOOT_MS);

describe("FRI-129: deploy is gated by skipZeroCache", () => {
  it("AC#5: deploy runs zero times for a skipZeroCache boot", () => {
    expect(skipBootInvocations).toBe(0);
  });
});
