/**
 * Vitest setup file — runs once per worker, before any test file is
 * loaded. Wired into every package's vitest.config.ts.
 *
 * The job here is narrow: guarantee that `FRIDAY_DATA_DIR` does NOT
 * resolve to the user's real `~/.friday/` directory by the time
 * `@friday/shared` is statically imported.
 *
 * Why this exists: `@friday/shared`'s `DATA_DIR` constant is captured
 * at module evaluation from `process.env.FRIDAY_DATA_DIR ?? homedir()/.friday`.
 * If a test file static-imports `@friday/shared` at the top *without*
 * having set `FRIDAY_DATA_DIR` first, all derived paths (APPS_DIR,
 * SKILLS_DIR, UPLOADS_DIR, etc.) point at the real user data dir.
 * Subsequent `rmSync(appDir(""), { recursive: true })`-style cleanup
 * inside the test then silently wipes the user's live data.
 *
 * This happened in May 2026: the Postgres cutover refactor of
 * `services/daemon/src/apps/installer.test.ts` moved `@friday/shared`
 * from a dynamic import to a static one and dropped the
 * `process.env.FRIDAY_DATA_DIR = mkdtempSync(...)` guard. Every
 * vitest run between then and discovery wiped `~/.friday/apps/`,
 * destroying the Kitchen app's recipes, menus, and weekly state.
 *
 * Mitigation: in this setup file (which vitest loads before any test
 * file's static imports resolve), force `FRIDAY_DATA_DIR` to a fresh
 * tmpdir if it's unset or points at `~/.friday/`. Test files that
 * want their own scoped tmpdir can still set `FRIDAY_DATA_DIR`
 * explicitly — vitest evaluates this file before the test file, so
 * the test file's own assignment will win for any DYNAMIC imports it
 * does in beforeAll. Static imports of `@friday/shared` from a test
 * file will see this file's default (which is safe).
 */

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const realFridayDir = resolve(join(homedir(), ".friday"));
const envValue = process.env.FRIDAY_DATA_DIR;
const envResolved = envValue ? resolve(envValue) : undefined;

if (envResolved === realFridayDir) {
  // An explicit assignment pointing at the real data dir is almost
  // certainly a bug — refuse to start so the test author notices.
  throw new Error(
    `vitest-setup: FRIDAY_DATA_DIR is set to the real user data dir ` +
      `(${realFridayDir}). Tests must point at a tmpdir to avoid ` +
      `clobbering live data. Unset FRIDAY_DATA_DIR (this setup file ` +
      `will substitute a tmpdir) or set it to a tmpdir explicitly.`,
  );
}

if (!envResolved) {
  const dir = mkdtempSync(join(tmpdir(), "friday-test-data-"));
  process.env.FRIDAY_DATA_DIR = dir;
}
