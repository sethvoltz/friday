/**
 * Per-worker test `FRIDAY_DATA_DIR` lifecycle (FRI-170).
 *
 * `vitest-setup.ts` gives each vitest worker an isolated `FRIDAY_DATA_DIR`
 * under `os.tmpdir()` (prefix {@link TEST_DATA_DIR_PREFIX}) so a test that
 * `rmSync`s its data dir can never touch the user's real `~/.friday/`. The
 * historical bug this module fixes: those dirs were `mkdtemp`'d but never
 * removed, so every run leaked one dir per worker — ~8,900 dirs / ~200 MB had
 * accumulated on the dev box before this was addressed.
 *
 * Reclaim model — a per-run **manifest** plus a crash backstop:
 *
 *  1. **Manifest + `globalSetup` teardown** (the guarantee). `global-setup.ts`
 *     runs once in the *main* vitest process: at start it calls
 *     {@link initDataDirManifest} (creating a per-run manifest file and
 *     exporting its path via {@link MANIFEST_ENV}, which the forked workers
 *     inherit); each {@link createManagedDataDir} call in a worker appends its
 *     dir to that manifest; at teardown {@link reclaimManifestDataDirs} removes
 *     every listed dir. The teardown fires once, in the main process, AFTER all
 *     files — so it does not depend on a per-file `afterAll` (which does NOT run
 *     for a fully-skipped file) nor on `process.on("exit")` (which does NOT fire
 *     under Vitest's forks pool — tinypool terminates workers without a clean
 *     exit). That is why this is a manifest-driven globalSetup teardown rather
 *     than a worker-side hook.
 *  2. **Startup sweep** (crash backstop). {@link sweepStaleDataDirs}, run once
 *     from `global-setup.ts` at run start, removes orphans left by a *prior*
 *     run whose main process died before its teardown fired. It is a best-effort
 *     heuristic, not a precise liveness check: it removes prefixed dirs whose
 *     top-level mtime is older than {@link STALE_DATA_DIR_AGE_MS}. The threshold
 *     assumes single-run operation; with two overlapping runs sharing
 *     `os.tmpdir()` a dir older than the threshold could in principle be swept,
 *     so the run's own ambient `FRIDAY_DATA_DIR` is passed via `protect` to
 *     exempt it unconditionally.
 *
 * Safety invariant (AC2): only dirs a worker *created* via
 * {@link createManagedDataDir} are ever recorded in the manifest and reclaimed.
 * A caller-provided `FRIDAY_DATA_DIR` is classified `adopt` by
 * {@link decideDataDir}, never recorded, and passed to the sweep's `protect`
 * set — so it is never deleted, even if it happens to sit under `os.tmpdir()`
 * with the reserved prefix.
 *
 * This module is dependency-free (node built-ins only) and vitest-free so the
 * `pnpm test:clean` maintenance script can reuse it without pulling in the test
 * runner.
 */

import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Prefix for every per-worker test data dir AND the per-run manifest dir. The
 *  sweep keys off this, so anything this module leaves under tmpdir is prefixed
 *  with it and thus reclaimable by a later run's startup sweep. */
export const TEST_DATA_DIR_PREFIX = "friday-test-data-";

/** Env var carrying the per-run manifest file path from `globalSetup` (main
 *  process) to the forked workers, which inherit it. */
export const MANIFEST_ENV = "FRIDAY_TEST_DATADIR_MANIFEST";

/**
 * Age threshold for the startup orphan sweep. A data dir is eligible for
 * sweeping only once its top-level mtime is older than this. Best-effort: a
 * directory's top-level mtime tracks direct-child changes, not deep writes, so
 * this is a coarse heuristic that assumes a single test run at a time, not a
 * precise "time since last use". 30 min is well above the lifetime of any
 * single in-use data dir under normal single-run operation while still
 * reclaiming crash orphans on the next run.
 */
export const STALE_DATA_DIR_AGE_MS = 30 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Data-dir decision (pure) — what should the setup file do with the
 * ambient FRIDAY_DATA_DIR? Extracted so the branch logic is unit-testable
 * without the mkdtemp side effect.
 * ------------------------------------------------------------------ */

export type DataDirDecision =
  | { kind: "reject"; realDir: string }
  | { kind: "adopt"; dir: string }
  | { kind: "create" };

/**
 * Classify the ambient `FRIDAY_DATA_DIR` against the real user data dir.
 *  - `reject`: env points at the real `~/.friday/` — the setup must throw.
 *  - `adopt`: env points at a caller-chosen dir — use it as-is, never record
 *    or delete it (this is the AC2 guarantee).
 *  - `create`: env is unset — the setup must mkdtemp a managed dir.
 */
export function decideDataDir(rawEnv: string | undefined, realFridayDir: string): DataDirDecision {
  const envResolved = rawEnv ? resolve(rawEnv) : undefined;
  if (envResolved && envResolved === realFridayDir)
    return { kind: "reject", realDir: realFridayDir };
  if (envResolved) return { kind: "adopt", dir: envResolved };
  return { kind: "create" };
}

/* ------------------------------------------------------------------ *
 * Removal primitive.
 * ------------------------------------------------------------------ */

/** `rmSync(recursive, force)` every dir, swallowing per-dir errors. */
export function removeDataDirsBestEffort(dirs: Iterable<string>): void {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort: vanished, perms, racing sweeper — ignore */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Per-run manifest. The source of truth for "dirs this run created".
 * ------------------------------------------------------------------ */

/**
 * Create the per-run manifest file and export its path via {@link MANIFEST_ENV}
 * so forked workers inherit it. The manifest lives in its own dir under
 * `os.tmpdir()`, prefixed so an orphaned manifest (teardown never fired) is
 * itself reclaimable by a later run's startup sweep. Returns the manifest path.
 */
export function initDataDirManifest(): string {
  const dir = mkdtempSync(join(tmpdir(), `${TEST_DATA_DIR_PREFIX}manifest-`));
  const manifest = join(dir, "data-dirs.txt");
  process.env[MANIFEST_ENV] = manifest;
  return manifest;
}

/**
 * `mkdtemp` a scoped data dir under `os.tmpdir()` and append it to the per-run
 * manifest (if one is active) so the `globalSetup` teardown will reclaim it.
 * Returns the absolute path. The append is the single line that makes the dir
 * reclaimable regardless of whether this file's tests run, skip, or crash.
 */
export function createManagedDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), TEST_DATA_DIR_PREFIX));
  const manifest = process.env[MANIFEST_ENV];
  if (manifest) {
    // One path per line; `appendFileSync` of a sub-PIPE_BUF write is atomic on
    // POSIX, so concurrent worker appends don't interleave.
    try {
      appendFileSync(manifest, `${dir}\n`);
    } catch {
      /* best-effort: an unrecorded dir is reclaimed by the next startup sweep */
    }
  }
  return dir;
}

/** Read the dir paths recorded in a manifest file. Missing/unreadable → []. */
export function readManifestDataDirs(manifestPath: string): string[] {
  try {
    return readFileSync(manifestPath, "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Remove every dir recorded in the manifest, then the manifest's own dir.
 * Best-effort; never throws. Returns the dir paths that were recorded. Called
 * from the `globalSetup` teardown in the main process after all files complete.
 */
export function reclaimManifestDataDirs(manifestPath: string): string[] {
  const dirs = readManifestDataDirs(manifestPath);
  removeDataDirsBestEffort(dirs);
  try {
    rmSync(dirname(manifestPath), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  return dirs;
}

/* ------------------------------------------------------------------ *
 * Startup orphan sweep (crash backstop).
 * ------------------------------------------------------------------ */

/**
 * Best-effort sweep of orphaned per-worker data dirs (and orphaned manifest
 * dirs) left by a prior run whose teardown never fired. Removes only
 * `${TEST_DATA_DIR_PREFIX}*` directories older than `ageMs` (default
 * {@link STALE_DATA_DIR_AGE_MS}), excluding any path in `protect`. Pure w.r.t.
 * injected `now`/`root`/`protect` for testability; never throws. Returns the
 * absolute paths removed.
 */
export function sweepStaleDataDirs(opts?: {
  ageMs?: number;
  now?: number;
  root?: string;
  protect?: Iterable<string>;
}): string[] {
  const ageMs = opts?.ageMs ?? STALE_DATA_DIR_AGE_MS;
  const root = opts?.root ?? tmpdir();
  const now = opts?.now ?? Date.now();
  const protect = new Set<string>();
  for (const p of opts?.protect ?? []) protect.add(resolve(p));
  const removed: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return removed; // tmp root unreadable — nothing to do
  }

  for (const name of entries) {
    if (!name.startsWith(TEST_DATA_DIR_PREFIX)) continue;
    const full = join(root, name);
    if (protect.has(resolve(full))) continue; // never sweep a protected dir
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs < ageMs) continue; // too fresh — may be in active use
      rmSync(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      /* racing another sweeper, perms, vanished mid-stat — skip */
    }
  }
  return removed;
}
