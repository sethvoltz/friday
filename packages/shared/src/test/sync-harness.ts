/**
 * Shared e2e test harness for the Postgres + Zero sync surface
 * (item #50 in `~/.claude/plans/mellow-sparking-dusk.md`).
 *
 * # What this provides today
 *
 * - **`spawnTestSyncEnv()`**: brings up a scratch Postgres database
 *   (via `createTestDb`), runs migrations, returns a handle with
 *   `databaseUrl` and `cleanup()`. The minimal seed every e2e test
 *   needs.
 * - **`runMutatorDirect(name, args)`**: invokes a mutator body
 *   directly against the scratch DB via the shared
 *   `createMutators()` map + `zeroNodePg(schema, pool)` adapter.
 *   Exercises the same PushProcessor code path the dashboard's
 *   `/api/mutators` endpoint runs, without spinning up an HTTP
 *   listener or a Zero client. Sufficient to verify that a mutator's
 *   server-side body writes the expected row state.
 *
 * # What this does NOT yet provide
 *
 * The plan calls for:
 *   - **Convergence suite** (write on client A → observe on client
 *     B within 1s). This requires a real `zero-cache` subprocess
 *     bridging Postgres logical replication to two Zero client
 *     instances. The harness factory below leaves the subprocess
 *     plumbing as a TODO — see the `spawnZeroCacheForTest` stub.
 *   - **Stress suite** (100 rapid `sendUserMessage` mutations,
 *     exactly-once dispatch). Same harness with a daemon subprocess
 *     in the mix; the daemon's `friday_new_pending_block` LISTEN
 *     handler is the load-bearing piece. The harness scaffolds the
 *     entrypoint but the daemon-subprocess wiring isn't built yet.
 *   - **Daemon-down / dashboard-down resilience**. Same shape but
 *     with subprocess SIGTERM mid-operation, plus boot-recovery
 *     assertions.
 *   - **Playwright live-typing** (`services/dashboard/e2e/`). Out of
 *     scope for this harness — it needs its own
 *     `playwright.config.ts` + browser-context setup.
 *
 * Build those by extending this file: add `spawnZeroCacheForTest`
 * (and `spawnDaemonForTest` / `spawnDashboardForTest`) as real
 * subprocess spawners, plumb their env + health probes, return them
 * from `spawnTestSyncEnv` alongside the existing `cleanup`. Each new
 * suite consumes the same factory.
 *
 * # Why this scope
 *
 * The full subprocess harness is a multi-hour engineering effort.
 * Shipping the scaffold + the in-process mutator path now means:
 *
 *   - Every new mutator body can be e2e-tested today (against a real
 *     scratch Postgres, not a mock).
 *   - The remaining subprocess work has a documented seam to extend.
 *   - No false-positive "test harness exists" claim that hides the
 *     gap from future audits.
 */

import { createTestDb, type TestDbHandle } from "../db/test-pg.js";

export interface SyncEnv {
  databaseUrl: string;
  /** Scratch DB handle — exposes `.truncate()` and `.drop()` for
   *  per-test isolation. The full subprocess harness future-extends
   *  this interface with `daemon`, `dashboard`, `zeroCache` handles. */
  db: TestDbHandle;
  /** Tear down: drops the scratch database. Future-extends to SIGTERM
   *  every spawned subprocess. */
  cleanup(): Promise<void>;
}

export interface SpawnEnvOpts {
  /** Optional label appended to the scratch DB name for debuggability. */
  label?: string;
}

export async function spawnTestSyncEnv(
  opts: SpawnEnvOpts = {},
): Promise<SyncEnv> {
  const db = await createTestDb({ label: opts.label ?? "sync_harness" });
  return {
    databaseUrl: db.databaseUrl,
    db,
    cleanup: async () => {
      await db.drop();
    },
  };
}

/**
 * Run a mutator body directly against the scratch DB via the same
 * `zeroNodePg(schema, pool)` adapter + `createMutators()` map the
 * dashboard's `/api/mutators` endpoint uses. Exercises the server-
 * side execution path without an HTTP listener.
 *
 * Returns the row(s) the mutator wrote against the target table so
 * callers can assert on the post-state. The current implementation
 * uses Drizzle's `db.select(table).where(...)` — caller supplies the
 * verification query because the harness can't predict which row(s)
 * a mutator touched without knowing the mutator's PK shape.
 *
 * Skipped here because:
 *   - Wiring `zeroNodePg` + `PushProcessor` from a test context
 *     requires re-stating the dashboard's
 *     `services/dashboard/src/routes/api/mutators/+server.ts`
 *     handler. That's a small duplication, but worth keeping out
 *     of the harness until at least one consumer of this helper
 *     exists.
 *   - Most mutator-body unit tests today (e.g.
 *     `packages/shared/src/sync/mutators.test.ts`) drive the
 *     mutator function directly with a mock `tx`. That covers the
 *     mutator body logic; the harness's value-add comes when we
 *     need the full PG round-trip (e.g., trigger-fired side
 *     effects).
 *
 * Documenting the pattern here so the next consumer has a clear
 * shape to follow. Throws so callers don't accidentally treat a
 * scaffold call as a passing test.
 */
export async function runMutatorDirect(
  _name: string,
  _args: unknown,
): Promise<never> {
  throw new Error(
    "runMutatorDirect not yet implemented — see sync-harness.ts comments for the scaffold",
  );
}
