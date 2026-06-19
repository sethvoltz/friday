/**
 * Dependency preflight — the single source of truth for "can Friday's stack
 * actually boot on this box?"
 *
 * Background (the incident this exists to prevent): a `friday update` that
 * crossed into the release introducing pgvector left the box without the
 * `vector` extension, and the daemon crash-looped at boot on migration 0036
 * (`type "vector" does not exist`). `friday update` runs the OUTGOING version's
 * code, so provisioning added in release N can never run on the hop INTO N —
 * but the launchd plist runs `…/current/bin/friday-supervisor` (the `current`
 * symlink), so the supervisor/daemon are always NEW code after a flip. The
 * durable fix therefore lives on the BOOT/START path, not the update path:
 *
 *   - `checkDeps()` (this module) is READ-ONLY. It never installs anything, so
 *     it is safe to call from the supervisor gate, `friday start`, `friday
 *     status`, and `friday doctor`. Actual installs live ONLY in the
 *     operator-interactive `friday provision` / `friday update` paths.
 *   - A HARD-missing dep halts the boot with an actionable remedy instead of
 *     crash-looping the daemon. A SOFT-missing dep degrades a feature (recall
 *     → FTS-only; no public tunnel) but never blocks boot.
 *
 * The DB-side checks reuse `probePostgresHealth` (reachable / role / database /
 * wal_level / migrations) and `hasVectorExtension` from `@friday/shared` so the
 * gate, doctor, and provisioning all agree on one definition of "healthy".
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { hasVectorExtension, probePostgresHealth, STATE_DIR } from "@friday/shared";
import { resolveBrew } from "./brew-deps.js";

/** A single dependency finding. `remedy` is the exact thing to run/do. */
export interface DepIssue {
  name: string;
  present: boolean;
  /** What the operator should run to fix it (shown verbatim in the gate). */
  remedy: string;
}

export interface DepReport {
  ok: boolean;
  /** Missing deps that BLOCK boot (daemon would crash-loop / serve nothing). */
  hard: DepIssue[];
  /** Missing deps that degrade a feature but DON'T block boot. */
  soft: DepIssue[];
}

/** The canonical "install everything" remedy the gate points at. */
export const PROVISION_REMEDY = "run `friday provision` then `friday restart`";

/** Whether `brew list <dep>` reports the dep installed (launchd-safe brew). */
function brewListHas(dep: string): boolean {
  const r = spawnSync(resolveBrew(), ["list", dep], { stdio: "ignore" });
  return r.status === 0;
}

/**
 * Read-only dependency report. Spawns `brew list` per dep (fast, idempotent)
 * and probes Postgres + the pgvector extension over TCP. NEVER installs or
 * mutates anything.
 *
 * The probes are injectable so the unit suite drives every branch without a
 * real brew or Postgres.
 */
export async function checkDeps(opts?: {
  brewHas?: (dep: string) => boolean;
  pgHealth?: () => Promise<{
    reachable: boolean;
    roleExists: boolean;
    databaseExists: boolean;
    walLevelLogical: boolean;
    walLevelActual: string | null;
  }>;
  vectorExtension?: () => Promise<boolean>;
}): Promise<DepReport> {
  const brewHasFn = opts?.brewHas ?? brewListHas;
  const pgHealthFn = opts?.pgHealth ?? (() => probePostgresHealth());
  const vectorFn = opts?.vectorExtension ?? (() => hasVectorExtension());

  const hard: DepIssue[] = [];
  const soft: DepIssue[] = [];

  // --- pgvector binary ---------------------------------------------------
  // The ONLY brew dep worth gating boot on: its absence is what crash-loops
  // the daemon with the cryptic `type "vector" does not exist` (migration
  // 0036). We deliberately do NOT loop every BREW_DEPS here — six sequential
  // `brew list` spawns add multiple seconds to the start/boot path, and the
  // others aren't boot-critical-or-detectable-here: postgresql@18's presence is
  // implied by the Postgres probe below, fnm is a prerequisite for the
  // supervisor to even run, and pnpm/gh/cloudflared are builder/tunnel-only
  // (`friday doctor` still reports all of them).
  if (!brewHasFn("pgvector")) {
    hard.push({ name: "brew:pgvector", present: false, remedy: PROVISION_REMEDY });
  }

  // --- Postgres + extension ---------------------------------------------
  // Reachability, role, database, and wal_level=logical are all HARD: a daemon
  // that can't reach its store, or a Postgres with wal_level != logical, boots
  // into failure (the latter boot-loops zero-cache — ADR-024). The `vector`
  // extension is HARD because migration 0036 references the `vector` type.
  const pg = await pgHealthFn();
  if (!pg.reachable) {
    hard.push({
      name: "postgres",
      present: false,
      remedy: "start Postgres: `brew services start postgresql@18`",
    });
  } else {
    if (!pg.roleExists || !pg.databaseExists) {
      hard.push({
        name: "postgres:role+db",
        present: false,
        remedy: PROVISION_REMEDY,
      });
    }
    if (!pg.walLevelLogical) {
      hard.push({
        name: "postgres:wal_level",
        present: false,
        remedy: `set \`wal_level = logical\` (currently ${pg.walLevelActual ?? "unknown"}) and restart Postgres`,
      });
    }
  }

  // The extension check only means anything once Postgres + the db exist; a
  // false from an unreachable Postgres would double-report the postgres miss.
  if (pg.reachable && pg.databaseExists) {
    const ext = await vectorFn();
    if (!ext) {
      hard.push({
        name: "pgvector:extension",
        present: false,
        remedy: PROVISION_REMEDY,
      });
    }
  }

  return { ok: hard.length === 0, hard, soft };
}

// --- Blocked-state file -------------------------------------------------
// The supervisor gate writes this when it refuses to bring up the stack; the
// daemon never spawns, so `friday status` reads this file (not a daemon API) to
// surface WHY the stack is dark and WHAT to run. Removed once deps are healthy.

export interface BlockedState {
  ts: string;
  hard: DepIssue[];
}

function blockedStatePath(): string {
  return join(STATE_DIR, "deps-blocked.json");
}

/** Persist the blocked report so `friday status` can surface it. */
export function writeBlockedState(state: BlockedState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(blockedStatePath(), JSON.stringify(state, null, 2));
}

/** Clear the blocked report (deps became healthy / stack came up). */
export function clearBlockedState(): void {
  try {
    rmSync(blockedStatePath(), { force: true });
  } catch {
    // Best-effort — a stale file is re-evaluated against live `checkDeps`
    // anyway; status treats it as advisory.
  }
}

/** Read the blocked report, or null when the stack isn't dep-blocked. */
export function readBlockedState(): BlockedState | null {
  const p = blockedStatePath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as BlockedState;
    if (!Array.isArray(raw.hard)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** One-line-per-issue remedy block, for printing in the gate / status. */
export function formatRemedies(issues: DepIssue[]): string {
  return issues.map((i) => `  · ${i.name} — ${i.remedy}`).join("\n");
}
