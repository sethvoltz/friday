/**
 * Homebrew dependency reconciliation for `friday update` (FRI-24).
 *
 * The TS twin of install.sh's `ensure_brew_deps`: install any Brewfile-tracked
 * dep that `brew list <dep>` reports absent, skipping ones already present
 * (idempotent). `friday update` calls this so an existing install picks up a
 * newly-added dep (e.g. `pgvector`, which supplies the `vector` extension the
 * post-update daemon boot requires for migration 0036) without the user having
 * to re-run the curl installer.
 *
 * BREW_DEPS MUST stay byte-for-byte in sync with install.sh's `BREW_DEPS`
 * (same set, same order) — they are the same provisioning contract expressed
 * twice (bash for the curl install, TS for in-place `friday update`).
 */

import { spawnSync } from "node:child_process";

/**
 * Brewfile-tracked third-party deps Friday relies on. MUST match install.sh's
 * `BREW_DEPS`. pgvector supplies the `vector` extension (FRI-24); the others
 * are the long-standing runtime/build deps.
 */
export const BREW_DEPS = ["fnm", "pnpm", "postgresql@18", "pgvector", "cloudflared", "gh"] as const;

/** Whether `brew list <dep>` reports the dep installed. */
function brewHas(dep: string): boolean {
  const r = spawnSync("brew", ["list", dep], { stdio: "ignore" });
  return r.status === 0;
}

/** Install a single brew dep. Returns true on success. */
function brewInstall(dep: string): boolean {
  const r = spawnSync("brew", ["install", dep], { stdio: "inherit" });
  return r.status === 0;
}

export interface EnsureBrewDepsResult {
  /** Deps found already installed (skipped — the idempotent path). */
  alreadyPresent: string[];
  /** Deps that were missing and installed successfully this run. */
  installed: string[];
  /** Deps that were missing and whose `brew install` failed. */
  failed: string[];
}

/**
 * Reconcile {@link BREW_DEPS}: install each missing one, skip present ones.
 * Best-effort — a failed `brew install` is recorded in `failed` (the caller
 * decides whether that's fatal) rather than thrown, mirroring install.sh's
 * `|| warn` behavior. Returns the partition of deps by outcome.
 *
 * The `has`/`install` probes are injectable so the unit suite asserts the
 * idempotent-skip + install-missing logic without shelling out to brew.
 */
export function ensureBrewDeps(opts?: {
  log?: (m: string) => void;
  has?: (dep: string) => boolean;
  install?: (dep: string) => boolean;
}): EnsureBrewDepsResult {
  const log = opts?.log ?? (() => {});
  const has = opts?.has ?? brewHas;
  const install = opts?.install ?? brewInstall;

  const alreadyPresent: string[] = [];
  const installed: string[] = [];
  const failed: string[] = [];

  for (const dep of BREW_DEPS) {
    if (has(dep)) {
      alreadyPresent.push(dep);
      continue;
    }
    log(`installing missing brew dep: ${dep}`);
    if (install(dep)) {
      installed.push(dep);
    } else {
      log(`brew install ${dep} failed — install it manually`);
      failed.push(dep);
    }
  }

  return { alreadyPresent, installed, failed };
}
