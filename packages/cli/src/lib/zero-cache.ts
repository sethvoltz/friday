/**
 * zero-cache spawn helpers, shared between the production supervisor
 * (`bin/supervisor.ts`) and the dev launcher (`bin/dev-zero.ts`).
 *
 * zero-cache is an external `@rocicorp/zero` binary: it can't call
 * `loadFridayConfig()`, so its caller reads the four secrets it needs and
 * injects them into the spawn env. Both call sites resolve the bin via a
 * direct path join off the dashboard's `node_modules` and spawn it via
 * `process.execPath` — never `pnpm exec` / the `.bin` shim, whose baked
 * absolute NODE_PATH doesn't survive relocation (FRI-146).
 *
 * Keeping the env-construction and the `zero-deploy-permissions` preStart in
 * one place means dev and prod can never drift on the publication name,
 * connection caps, sync-worker pin, or secret-injection set.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { FRIDAY_PG_CONSTANTS, type FridayEnvConfig } from "@friday/shared";

/**
 * `@rocicorp/zero`'s `cli.js` (the `zero-cache` bin). `require.resolve` on the
 * package subpath fails — the exports map doesn't export `./package.json` — so
 * resolve the bin's compiled entry directly. The bin map pins `zero-cache` →
 * `./out/zero/src/cli.js`.
 */
export function zeroCacheCli(repoRoot: string): string {
  return join(
    repoRoot,
    "services",
    "dashboard",
    "node_modules",
    "@rocicorp",
    "zero",
    "out",
    "zero",
    "src",
    "cli.js",
  );
}

/** `@rocicorp/zero`'s `zero-deploy-permissions` bin → `deploy-permissions.js`. */
export function zeroDeployPermissionsCli(repoRoot: string): string {
  return join(
    repoRoot,
    "services",
    "dashboard",
    "node_modules",
    "@rocicorp",
    "zero",
    "out",
    "zero",
    "src",
    "deploy-permissions.js",
  );
}

/** zero-cache + deploy-permissions both run from the dashboard package dir. */
export function zeroCacheCwd(repoRoot: string): string {
  return join(repoRoot, "services", "dashboard");
}

/**
 * Build the zero-cache spawn env. `dashboardPort` is the origin of the
 * dashboard serving `/api/mutators` (the push processor) — the prod
 * dashboard port under the supervisor, or the vite dev port (5173) under
 * the dev launcher.
 */
export function buildZeroCacheEnv(
  fridayEnv: FridayEnvConfig,
  dashboardPort: number,
): NodeJS.ProcessEnv {
  return {
    // System default for the single-user local instance: zero-cache otherwise
    // auto-sizes sync workers to ~1-per-core (availableParallelism() - 1), each
    // holding ~5 Postgres connections (~42 on a 10-core Mac). Pinning to 2 keeps
    // realtime sync parallelism while cutting connections ~65%. Placed BEFORE the
    // process.env spread so it is a DEFAULT the user can override via
    // ZERO_NUM_SYNC_WORKERS in ~/.friday/.env.local. Takes effect on next restart.
    ZERO_NUM_SYNC_WORKERS: "2",
    // System default placed BEFORE the process.env spread so ~/.friday/.env.local
    // overrides it. zero-cache must target Friday's logical-replication
    // publication (created by `ensurePublication` in pg-provision).
    ZERO_APP_PUBLICATIONS: FRIDAY_PG_CONSTANTS.FRIDAY_PUBLICATION,
    // System defaults for the single-user local instance. zero-cache bounds total
    // syncer connections by these CLUSTER-WIDE caps — the real lever for connection
    // count, distinct from the worker count — divided across sync workers. With
    // ZERO_NUM_SYNC_WORKERS=2 these divide to ~2 upstream + ~3 CVR per worker (the
    // per-worker floor must stay ≥ the worker count or zero-cache throws at startup,
    // so 4 and 6 are the safe minimum for 2 workers). Placed BEFORE the process.env
    // spread so ~/.friday/.env.local can override them.
    ZERO_UPSTREAM_MAX_CONNS: "4",
    ZERO_CVR_MAX_CONNS: "6",
    ...process.env,
    // FRI-150 (pivot, ADR-037): explicit secret injection. zero-cache is an
    // external binary; the caller reads via loadFridayConfig() and hands the
    // secrets it needs to the spawn env.
    ...(fridayEnv.zeroUpstreamDb ? { ZERO_UPSTREAM_DB: fridayEnv.zeroUpstreamDb } : {}),
    ZERO_AUTH_SECRET: fridayEnv.zeroAuthSecret,
    ZERO_ADMIN_PASSWORD: fridayEnv.zeroAdminPassword,
    ...(fridayEnv.zeroReplicaFile ? { ZERO_REPLICA_FILE: fridayEnv.zeroReplicaFile } : {}),
    ZERO_LOG_FORMAT: "json",
    // FRI-83 follow-up: the spawn-time export of ZERO_MUTATE_URL is the
    // source of truth, beating any stale value in .env.local.
    ZERO_MUTATE_URL: `http://localhost:${dashboardPort}/api/mutators`,
  };
}

/**
 * One-shot `zero-deploy-permissions` step run before zero-cache is first
 * spawned. Reads the same secrets zero-cache needs. Throws on non-zero exit.
 */
export function runZeroDeployPermissions(repoRoot: string, fridayEnv: FridayEnvConfig): void {
  const schemaPath = join(repoRoot, "packages", "shared", "dist", "sync", "schema.js");
  // Spawn via `process.execPath` against the bin's compiled entry — never
  // `pnpm exec` / the `.bin` shim (FRI-146).
  const r = spawnSync(
    process.execPath,
    [zeroDeployPermissionsCli(repoRoot), "--schema-path", schemaPath],
    {
      cwd: zeroCacheCwd(repoRoot),
      stdio: "inherit",
      env: {
        ...process.env,
        ...(fridayEnv.zeroUpstreamDb ? { ZERO_UPSTREAM_DB: fridayEnv.zeroUpstreamDb } : {}),
        ZERO_AUTH_SECRET: fridayEnv.zeroAuthSecret,
        ZERO_ADMIN_PASSWORD: fridayEnv.zeroAdminPassword,
      },
    },
  );
  if (r.status !== 0) {
    throw new Error(`zero-deploy-permissions exited ${r.status}`);
  }
}
