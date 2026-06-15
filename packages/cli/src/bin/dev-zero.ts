/**
 * dev-zero — boot a foreground zero-cache for local dev (`pnpm dev:zero`).
 *
 * The production stack runs zero-cache under the launchd supervisor
 * (`bin/supervisor.ts`). Dev historically had no zero-cache launcher of its
 * own: `pnpm dev:daemon` + `pnpm dev:dashboard` leaned on the *prod*
 * zero-cache already running on :4848. Once a box stops hosting prod (e.g.
 * after a `friday restore` migrates serving to another machine), nothing
 * binds :4848 and the dev dashboard spins on "Syncing your data" forever.
 *
 * This launcher closes that gap: it reuses the supervisor's exact env
 * construction + `zero-deploy-permissions` preStart (lib/zero-cache) so dev
 * and prod can't drift, and runs zero-cache in the foreground with inherited
 * stdio. It binds the same :4848 the dev dashboard's Zero client connects to
 * directly (zero.svelte.ts `zeroServerUrl()` → `http://<host>:4848` in dev),
 * so a phone on `vite dev --host` reaches it over the LAN IP.
 *
 * ZERO_MUTATE_URL points at the vite dev dashboard (:5173 by default, or
 * FRIDAY_DASHBOARD_PORT) — the push processor that `/api/mutators` serves.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFridayConfig } from "@friday/shared";
import {
  buildZeroCacheEnv,
  runZeroDeployPermissions,
  zeroCacheCli,
  zeroCacheCwd,
} from "../lib/zero-cache.js";

/** Repo root: walk up from this file until we find pnpm-workspace.yaml. */
function findRepoRoot(): string {
  let cur = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(cur, "pnpm-workspace.yaml"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error("dev-zero: cannot locate repo root (no pnpm-workspace.yaml)");
}

const repoRoot = findRepoRoot();
const fridayEnv = loadFridayConfig();
// vite dev serves the dashboard (incl. /api/mutators) on :5173 by default.
const dashboardPort = process.env.FRIDAY_DASHBOARD_PORT
  ? Number(process.env.FRIDAY_DASHBOARD_PORT)
  : 5173;

const schemaJs = join(repoRoot, "packages", "shared", "dist", "sync", "schema.js");
if (!existsSync(schemaJs)) {
  console.error(
    `dev-zero: ${schemaJs} missing — run \`pnpm --filter @friday/shared build\` first.`,
  );
  process.exit(1);
}

console.error(`dev-zero: deploying Zero permissions (dashboard → :${dashboardPort})…`);
runZeroDeployPermissions(repoRoot, fridayEnv);

console.error("dev-zero: starting zero-cache on :4848 (binds 0.0.0.0 for LAN)…");
const child = spawn(process.execPath, [zeroCacheCli(repoRoot)], {
  cwd: zeroCacheCwd(repoRoot),
  stdio: "inherit",
  env: buildZeroCacheEnv(fridayEnv, dashboardPort),
});

// Forward termination so Ctrl-C tears zero-cache (and its worker pool) down.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
