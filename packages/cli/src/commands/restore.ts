/**
 * `friday restore <bundle-path> [--force]` — recover Friday state
 * from a backup tarball produced by `friday backup` (Phase 7a).
 *
 * Contract (plan §237):
 *   1. Refuses if the daemon is running (would race the migration).
 *   2. Refuses if the `friday` database has user data, unless `--force`.
 *      Detection: the `users` table has > 0 rows (BetterAuth's
 *      single-user marker; a fresh install has 0).
 *   3. Validates the bundle: tarball extracts cleanly + `manifest.json`
 *      checksum matches `postgres.dump`.
 *   4. Drops + recreates the `friday` database.
 *   5. Restores `pg_dump` output via `pg_restore`.
 *   6. Re-runs Drizzle migrations (idempotent — bundles produced after a
 *      schema bump have the new tables; older bundles get the diff
 *      applied to land at the running daemon's schema).
 *   7. Restores filesystem (copies staged dirs/files back into DATA_DIR,
 *      preserving timestamps).
 *   8. Re-runs `friday doctor` for a final readiness check.
 */

import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { confirm } from "@clack/prompts";
import pc from "picocolors";
import { DATA_DIR, ENV_PATH, HEALTH_PATH, runMigrations } from "@friday/shared";

const BACKUP_PATHS = [
  ".env",
  "SOUL.md",
  "config.json",
  "skills",
  "memory/entries",
  "evolve/proposals",
  "apps",
  "schedules",
  "uploads",
] as const;

interface BackupManifest {
  createdAt: string;
  bundleId: string;
  schemaVersion: number;
  postgresDumpSha256: string;
  fridayVersion: string;
  files: Array<{ path: string; exists: boolean }>;
}

export const restoreCommand = defineCommand({
  meta: {
    name: "restore",
    description: "Restore Friday state from a backup tarball.",
  },
  args: {
    bundle: {
      type: "positional",
      description: "Path to a .tar.gz backup bundle (from `friday backup`).",
      required: true,
    },
    force: {
      type: "boolean",
      description:
        "Overwrite a non-empty friday database without prompting. Required when the existing database has user data.",
      default: false,
    },
  },
  async run({ args }) {
    const bundlePath = String(args.bundle);
    if (!existsSync(bundlePath)) {
      console.error(pc.red(`✗ bundle not found: ${bundlePath}`));
      process.exit(1);
    }

    console.log(pc.bold(`Friday restore ← ${bundlePath}`));

    // 1. Refuse if the daemon or zero-cache is running. Both hold
    //    connections to the friday database / replication slot.
    if (daemonAppearsRunning()) {
      console.error(
        pc.red(
          "✗ daemon appears to be running. Stop it first: `friday stop daemon`.",
        ),
      );
      process.exit(1);
    }
    if (zeroCacheAppearsRunning()) {
      console.error(
        pc.red(
          "✗ zero-cache is running and holds the friday replication slot. Stop it first: `friday stop zero-cache`.",
        ),
      );
      process.exit(1);
    }

    // Stage extracted bundle in a tempdir so we can validate before
    // touching the live database or filesystem.
    const stageDir = await mkdtemp(join(tmpdir(), "friday-restore-"));
    try {
      const tar = spawnSync("tar", ["-xzf", bundlePath, "-C", stageDir], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      if (tar.status !== 0) {
        throw new Error(`tar extraction failed with status ${tar.status}.`);
      }

      // 2. Validate the bundle. Manifest must exist + dump checksum
      //    must match. Schema version >1 means a newer Friday — refuse.
      const manifestPath = join(stageDir, "manifest.json");
      if (!existsSync(manifestPath)) {
        throw new Error(
          "Bundle is missing manifest.json — not a Friday backup tarball.",
        );
      }
      const manifest = JSON.parse(
        readFileSync(manifestPath, "utf8"),
      ) as BackupManifest;
      if (manifest.schemaVersion !== 1) {
        throw new Error(
          `Bundle schema version ${manifest.schemaVersion} is not supported by this CLI (expected 1).`,
        );
      }
      const dumpPath = join(stageDir, "postgres.dump");
      if (!existsSync(dumpPath)) {
        throw new Error("Bundle is missing postgres.dump.");
      }
      const dumpSha = sha256File(dumpPath);
      if (dumpSha !== manifest.postgresDumpSha256) {
        throw new Error(
          `postgres.dump checksum mismatch: bundle has ${manifest.postgresDumpSha256}, computed ${dumpSha}. Bundle is corrupt.`,
        );
      }
      console.log(
        pc.dim(
          `  bundle ${manifest.bundleId} · ${manifest.fridayVersion} · created ${manifest.createdAt}`,
        ),
      );

      // 3. Refuse if the destination database has user data unless --force.
      const hasUserData = checkDatabaseHasUsers();
      if (hasUserData && !args.force) {
        const ok = await confirm({
          message:
            "Existing friday database has user data. Overwrite? (Re-run with --force to skip this prompt.)",
          initialValue: false,
        });
        if (typeof ok !== "boolean" || !ok) {
          console.log(pc.yellow("Aborted."));
          process.exit(1);
        }
      }

      // 4. Drop + recreate the friday database. `pg_dump` was taken
      //    with --no-owner --no-privileges so we don't need to recreate
      //    the role here; `friday setup` provisions that on first run.
      //    Zero-cache holds a logical-replication slot on `friday`; we
      //    drop those slots first so DROP DATABASE doesn't fail. They
      //    get recreated automatically the next time zero-cache starts.
      console.log(
        pc.dim("  dropping zero-cache replication slots (if any)…"),
      );
      // Terminate any backend still holding the slot (zero-cache may
      // have died without releasing) so pg_drop_replication_slot
      // doesn't error with "slot active for PID …".
      runPsqlAdmin([
        "-c",
        `SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE database = 'friday' AND active_pid IS NOT NULL;`,
        "-c",
        `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE database = 'friday';`,
      ]);
      console.log(pc.dim("  dropping + recreating friday database…"));
      runPsqlAdmin([
        "-c",
        "DROP DATABASE IF EXISTS friday;",
        "-c",
        'CREATE DATABASE friday OWNER friday;',
      ]);

      // 5. Restore the pg_dump custom-format archive. Connect as the
      //    `friday` role via DATABASE_URL so all restored objects end
      //    up owned by it — otherwise the dump's `--no-owner` flag
      //    leaves them owned by whoever ran pg_restore (typically
      //    `seth` under macOS peer auth), and runMigrations later
      //    fails with `permission denied for schema drizzle`. Sourcing
      //    .env now also gives runMigrations the URL it needs.
      sourceEnvFromFile(ENV_PATH);
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) {
        throw new Error(
          "DATABASE_URL is missing from ~/.friday/.env after restore. Re-run `friday setup` first.",
        );
      }
      console.log(pc.dim("  pg_restore…"));
      const pgRestore = spawnSync(
        "pg_restore",
        ["--no-owner", "--no-privileges", "-d", dbUrl, dumpPath],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      if (pgRestore.status !== 0) {
        throw new Error(
          `pg_restore exited with status ${pgRestore.status}.`,
        );
      }

      // 6. Restore filesystem. Each path that existed at backup time is
      //    copied back into DATA_DIR. Existing target is removed first
      //    so we don't end up with merged-state surprises.
      console.log(pc.dim("  restoring filesystem…"));
      mkdirSync(DATA_DIR, { recursive: true });
      for (const rel of BACKUP_PATHS) {
        const src = join(stageDir, rel);
        if (!existsSync(src)) continue;
        const dest = join(DATA_DIR, rel);
        if (existsSync(dest)) {
          rmSync(dest, { recursive: true, force: true });
        }
        mkdirSync(dirname(dest), { recursive: true });
        await cp(src, dest, { recursive: true, preserveTimestamps: true });
      }

      // 7. Re-apply pending migrations. A bundle from an older Friday
      //    may not have the latest schema; runMigrations is idempotent
      //    against already-applied migrations and brings the DB to head.
      console.log(pc.dim("  re-running drizzle migrations…"));
      await runMigrations();

      // 8. Final readiness check. Spawn `friday doctor` so the user
      //    sees the same exit status they'd get on a fresh install.
      console.log(pc.dim("  friday doctor…"));
      const doctor = spawnSync(
        process.argv[0]!,
        [process.argv[1]!, "doctor"],
        { stdio: "inherit" },
      );
      const doctorStatus = doctor.status ?? 1;

      console.log();
      console.log(
        doctorStatus === 0
          ? pc.green("✓ restore complete")
          : pc.yellow(
              `✓ restore complete · friday doctor exited ${doctorStatus} (investigate before starting the daemon)`,
            ),
      );
    } finally {
      await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
  },
});

function daemonAppearsRunning(): boolean {
  // The right signal is "is there a process answering on the daemon
  // port" — health.json's mtime stays fresh even after `friday stop`
  // (the file isn't cleaned up on shutdown). Probe the port directly.
  if (!existsSync(HEALTH_PATH)) return false;
  let health: { port?: unknown; pid?: unknown } | null = null;
  try {
    health = JSON.parse(readFileSync(HEALTH_PATH, "utf8")) as {
      port?: unknown;
      pid?: unknown;
    };
  } catch {
    return false;
  }
  const port = typeof health?.port === "number" ? (health.port as number) : null;
  if (port === null) return false;
  // lsof tells us whether the port is being LISTENed on right now.
  const probe = spawnSync(
    "lsof",
    ["-iTCP:" + port, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8" },
  );
  return probe.status === 0 && probe.stdout.trim().length > 0;
}

function zeroCacheAppearsRunning(): boolean {
  // zero-cache binds 127.0.0.1:4848 (configurable via ZERO_PORT but the
  // default ships unchanged in our deployment). lsof tells us whether
  // anything is LISTENing there.
  const port = process.env.ZERO_PORT
    ? Number(process.env.ZERO_PORT)
    : 4848;
  if (!Number.isFinite(port)) return false;
  const probe = spawnSync(
    "lsof",
    ["-iTCP:" + port, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8" },
  );
  return probe.status === 0 && probe.stdout.trim().length > 0;
}

function checkDatabaseHasUsers(): boolean {
  // Probe via `psql -At` for an exit-quiet integer. `friday` may not
  // exist yet (first-time restore), which we treat as "no user data."
  const res = spawnSync(
    "psql",
    [
      "-At",
      "-d",
      "friday",
      "-c",
      "SELECT count(*) FROM \"user\";",
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) return false;
  const n = Number(res.stdout.trim());
  return Number.isFinite(n) && n > 0;
}

function runPsqlAdmin(extraArgs: string[]): void {
  // Connect to the default `postgres` database so we can DROP friday
  // while no one else is connected. Local Postgres trust auth means we
  // don't need credentials here.
  const res = spawnSync("psql", ["-d", "postgres", ...extraArgs], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (res.status !== 0) {
    throw new Error(
      `psql admin command failed with status ${res.status}. Manual cleanup may be required.`,
    );
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Parse a `KEY=value` `.env` file and inject any keys not already set
 *  in `process.env`. Mirrors the daemon's startup behavior so
 *  `runMigrations()` can find `DATABASE_URL` after a restore. */
function sourceEnvFromFile(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes.
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

