/**
 * `friday backup [output-path]` — pack the canonical Friday state into a
 * single tarball for cross-machine transport or disaster recovery.
 *
 * Contents (per plan §232):
 *   - `pg_dump friday` → `postgres.dump` (custom format)
 *   - `~/.friday/.env.local`
 *   - `~/.friday/secrets/` (vault.enc, meta.yaml, recipients.txt)
 *   - `~/.friday/SOUL.md`
 *   - `~/.friday/config.json`
 *   - `~/.friday/skills/`
 *   - `~/.friday/memory/entries/`
 *   - `~/.friday/evolve/proposals/`
 *   - `~/.friday/apps/`
 *   - `~/.friday/schedules/`
 *   - `~/.friday/uploads/` (content-addressed; often the biggest piece)
 *   - `manifest.json` (timestamp, plan version, dump hash, file inventory)
 *
 * Excludes (intentional):
 *   - `workspaces/` (builder git worktrees — rebuildable from upstream branches)
 *   - `logs/` (per-session JSONL; large + ephemeral)
 *   - `health.json` (snapshot; stale by the time anyone reads it)
 *   - `usage.jsonl` (large telemetry log)
 *   - `zero/` (zero-cache replica; rebuilt from Postgres logical replication)
 *   - `state/` (process-supervisor bookkeeping; tied to the running machine)
 *
 * Atomic: writes to `<output>.tmp` then renames on success.
 */

import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import pc from "picocolors";
import { DATA_DIR } from "@friday/shared";
import pkg from "../../package.json" with { type: "json" };

/** Files / directories — relative to DATA_DIR — that go in every backup
 *  when they exist. Anything missing is silently skipped (e.g. a fresh
 *  install with no evolve proposals yet). */
const BACKUP_PATHS = [
  ".env.local",
  "secrets",
  "SOUL.md",
  "config.json",
  "skills",
  "memory/entries",
  "evolve/proposals",
  "apps",
  "schedules",
  "uploads",
] as const;

interface ManifestFileEntry {
  path: string;
  exists: boolean;
}

interface BackupManifest {
  /** ISO timestamp of when the backup was taken. */
  createdAt: string;
  /** UUID for this specific bundle. */
  bundleId: string;
  /** Friday plan version this bundle was produced under — pinned to the
   *  Postgres + Zero sync architecture (Phase 7). Future schema changes
   *  bump this so `friday restore` can detect incompatibility upfront. */
  schemaVersion: 1;
  /** SHA-256 of `postgres.dump` — verified at restore time. */
  postgresDumpSha256: string;
  /** Friday version (root package.json) when this backup was produced. */
  fridayVersion: string;
  /** Path inventory at backup time — diagnostic, not load-bearing. */
  files: ManifestFileEntry[];
}

export const backupCommand = defineCommand({
  meta: {
    name: "backup",
    description: "Pack Friday state into a portable tarball.",
  },
  args: {
    output: {
      type: "positional",
      description: "Output path (default: ~/.friday/backups/<timestamp>.tar.gz)",
      required: false,
    },
    "include-age-key": {
      type: "boolean",
      description: "Include .age-key in the bundle (off by default)",
    },
  },
  async run({ args }) {
    const outputPath = resolveOutputPath(args.output);
    mkdirSync(dirname(outputPath), { recursive: true });

    console.log(pc.bold(`Friday backup → ${outputPath}`));

    // Stage everything in a temp dir, then tar+gz it. This keeps the
    // pg_dump and the file copies on the same filesystem (cross-FS rename
    // would block atomicity) and gives us a single rename at the end.
    const stageDir = await mkdtemp(join(tmpdir(), "friday-backup-"));
    try {
      // 1. pg_dump → postgres.dump (custom format, single file).
      const dumpPath = join(stageDir, "postgres.dump");
      const pgDump = spawnSync(
        "pg_dump",
        ["-Fc", "-f", dumpPath, "--no-owner", "--no-privileges", "friday"],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      if (pgDump.status !== 0) {
        throw new Error(
          `pg_dump exited with status ${pgDump.status}. Is the friday database accessible? Check 'pg_isready' and PGUSER.`,
        );
      }
      const dumpSha = sha256File(dumpPath);
      console.log(
        pc.dim(`  postgres.dump  ${formatBytes(fileSize(dumpPath))}  ${dumpSha.slice(0, 12)}…`),
      );

      // 2. Copy filesystem contents (each via fs walk that respects the
      //    `existsSync` skip — a fresh install may not have all dirs).
      const fileInventory: ManifestFileEntry[] = [];
      if (args["include-age-key"]) {
        const ageKey = join(DATA_DIR, ".age-key");
        if (existsSync(ageKey)) {
          const dest = join(stageDir, ".age-key");
          const cp = spawnSync("cp", [ageKey, dest], { stdio: ["ignore", "inherit", "inherit"] });
          if (cp.status !== 0) throw new Error("Failed to copy .age-key");
          console.log(pc.yellow("  .age-key included — protect this bundle like a password"));
        }
      } else if (existsSync(join(DATA_DIR, "secrets", "vault.enc"))) {
        // Migration gotcha: the encrypted vault is in the bundle, but it can't be
        // decrypted on another machine without `.age-key`. Warn so a migration
        // bundle isn't silently non-portable for secrets (Cloudflare tunnel
        // token, integration API keys, app secrets).
        console.log(
          pc.yellow("  note: .age-key NOT included — secrets/vault.enc won't decrypt elsewhere."),
        );
        console.log(
          pc.yellow(
            "        For a migration, re-run with --include-age-key (or copy ~/.friday/.age-key separately).",
          ),
        );
      }

      for (const rel of BACKUP_PATHS) {
        const abs = join(DATA_DIR, rel);
        const exists = existsSync(abs);
        fileInventory.push({ path: rel, exists });
        if (!exists) continue;
        const dest = join(stageDir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        // Use system `cp -R` rather than reimplementing a recursive copy —
        // small dependency and handles symlinks / permissions natively.
        const cp = spawnSync("cp", ["-R", abs, dest], {
          stdio: ["ignore", "inherit", "inherit"],
        });
        if (cp.status !== 0) {
          throw new Error(`Failed to copy ${rel} into staging directory.`);
        }
      }

      // 3. manifest.json (sanity + restore-time verification anchor).
      const manifest: BackupManifest = {
        createdAt: new Date().toISOString(),
        bundleId: randomUUID(),
        schemaVersion: 1,
        postgresDumpSha256: dumpSha,
        fridayVersion: pkg.version,
        files: fileInventory,
      };
      writeFileSync(join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

      // 4. tar+gz the staged contents into a tmp tarball next to the
      //    target path so the final rename stays on the same filesystem.
      //    System `tar` (BSD tar on macOS, GNU tar on Linux) accepts the
      //    same `-czf -C <cwd> .` shape on both platforms.
      const tmpOutput = outputPath + ".tmp";
      if (existsSync(tmpOutput)) unlinkSync(tmpOutput);
      const tar = spawnSync("tar", ["-czf", tmpOutput, "-C", stageDir, "."], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      if (tar.status !== 0) {
        throw new Error(`tar exited with status ${tar.status}.`);
      }
      renameSync(tmpOutput, outputPath);

      console.log(pc.green(`✓ backup complete · ${formatBytes(fileSize(outputPath))}`));
      console.log(pc.dim(`  bundle ${manifest.bundleId}`));
    } finally {
      await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
  },
});

function resolveOutputPath(arg: unknown): string {
  if (typeof arg === "string" && arg.length > 0) return arg;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "_").replace(/Z$/, "");
  return join(DATA_DIR, "backups", `${ts}.tar.gz`);
}

function sha256File(path: string): string {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
}

function fileSize(path: string): number {
  return statSync(path).size;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
