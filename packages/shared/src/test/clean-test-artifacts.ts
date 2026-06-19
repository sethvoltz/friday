/**
 * `pnpm test:clean` (FRI-170) — manual reclaim of leaked test artifacts.
 *
 * Run when **no test run is in progress**. It removes every per-worker
 * `friday-test-data-*` tmp dir and drops every idle (zero-session)
 * `friday_test_*` scratch database. The automatic mechanisms (exit hook +
 * startup sweep in `tmp-data-dir.ts`, `createTestDb().drop()` in `test-pg.ts`)
 * keep things clean during normal runs; this is the catch-all for orphans left
 * by hard crashes.
 *
 * The tmp-dir sweep here uses `ageMs: 0` (reclaim all), which is why it must run
 * when idle — unlike the startup sweep it does not spare fresh dirs. The DB
 * sweep is concurrency-safe regardless (it only drops DBs with no live session).
 */

import { tmpdir } from "node:os";
import { sweepStaleTestDbs } from "../db/test-pg.js";
import { TEST_DATA_DIR_PREFIX, sweepStaleDataDirs } from "./tmp-data-dir.js";

async function main(): Promise<void> {
  const removedDirs = sweepStaleDataDirs({ ageMs: 0 });
  console.log(
    `[test:clean] removed ${removedDirs.length} ${TEST_DATA_DIR_PREFIX}* dir(s) under ${tmpdir()}`,
  );

  try {
    const droppedDbs = await sweepStaleTestDbs();
    console.log(`[test:clean] dropped ${droppedDbs.length} idle friday_test_* database(s)`);
  } catch (err) {
    // No reachable Postgres (or admin failure) — the tmp-dir reclaim still ran.
    console.warn(`[test:clean] scratch-DB sweep skipped: ${(err as Error).message}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
