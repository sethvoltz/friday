/**
 * Vitest `globalSetup` for the per-worker test data-dir lifecycle (FRI-170).
 *
 * Runs ONCE in the main vitest process per invocation. It owns the two
 * run-level reclaim concerns (see `./tmp-data-dir.ts` for the full model):
 *
 *  - At start: a best-effort startup sweep of orphan dirs left by a prior run
 *    whose teardown never fired, plus creation of the per-run manifest whose
 *    path is exported (via env) to the forked workers.
 *  - At teardown (fires once, after all files, regardless of skips or
 *    worker-kills): removal of every dir the workers recorded in the manifest.
 *
 * Wired as `globalSetup` in every package's vitest config alongside the
 * `vitest-setup.ts` setupFile (pinned by `vitest-config-wiring.test.ts`).
 */

import { resolve } from "node:path";
import {
  initDataDirManifest,
  reclaimManifestDataDirs,
  sweepStaleDataDirs,
} from "./tmp-data-dir.js";

export default function setup(): () => void {
  // Reclaim orphans from prior runs (main process died before teardown). Runs
  // before any worker dir exists, so it cannot sweep this run's dirs; protect a
  // caller-provided FRIDAY_DATA_DIR (the `adopt` case) unconditionally.
  const adopted = process.env.FRIDAY_DATA_DIR ? [resolve(process.env.FRIDAY_DATA_DIR)] : [];
  sweepStaleDataDirs({ protect: adopted });

  const manifest = initDataDirManifest();

  return () => {
    reclaimManifestDataDirs(manifest);
  };
}
