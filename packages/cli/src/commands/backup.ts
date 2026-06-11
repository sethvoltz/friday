/**
 * `friday backup [output-path]` — pack Friday state into a single tarball for
 * cross-machine transport or disaster recovery.
 *
 * Two modes:
 *
 *   DEFAULT (selective) — the canonical curated set (plan §232):
 *     postgres.dump, .env.local, secrets/, SOUL.md, config.json, skills/,
 *     memory/entries/, evolve/proposals/, apps/, schedules/, uploads/.
 *     `--include-age-key` adds .age-key.
 *
 *   --full — a complete, faithful migration bundle:
 *     postgres.dump + the WHOLE ~/.friday (including the `.git` state repo,
 *     `.env.local`, `agents/` homes, `uploads/`) MINUS regenerable/machine-tied
 *     bulk (`workspaces/`, `zero/`, `logs/`, `state/`, `backups/`, `health.json`),
 *     PLUS the Claude SDK session transcripts (`~/.claude/projects/<cwd>/<sid>.jsonl`
 *     + sidecars) for every non-archived agent — without those, the SDK silently
 *     starts a FRESH session post-restore and the agent loses its Claude-side
 *     conversation context. `--include-age-key` adds .age-key (→ NOT distribution
 *     safe). Sessions are stored keyed BY AGENT so restore re-derives the target
 *     machine's `~/.claude/projects/<cwd-hash>` path rather than reusing ours.
 *
 * Atomic: writes to `<output>.tmp` then renames on success.
 */

import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
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
import { ne } from "drizzle-orm";
import pc from "picocolors";
import {
  DATA_DIR,
  findPgBin,
  getDb,
  schema,
  sessionFilePath,
  sessionSidecarDir,
} from "@friday/shared";
import pkg from "../../package.json" with { type: "json" };

/** Files / directories — relative to DATA_DIR — that go in every SELECTIVE
 *  backup when they exist. Anything missing is silently skipped. */
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

/** Top-level `~/.friday` entries excluded from a `--full` bundle: regenerable
 *  (rebuilt from Postgres / upstream git) or machine-tied (supervisor state). */
const FULL_EXCLUDE = new Set<string>([
  "workspaces", // builder git worktrees — rebuilt from upstream branches
  "zero", // zero-cache replica — rebuilt from Postgres logical replication
  "logs", // per-session JSONL; large + ephemeral
  "backups", // don't recurse prior backups into this one
  "state", // process-supervisor bookkeeping; tied to the running machine
  "health.json", // snapshot; stale by the time anyone reads it
  ".playwright-mcp", // scratch
]);

interface ManifestFileEntry {
  path: string;
  exists: boolean;
}

/** A Claude SDK session captured into a `--full` bundle, keyed by agent so
 *  restore re-derives the target `~/.claude/projects/<cwd-hash>` path. */
interface ClaudeSessionEntry {
  agent: string;
  type: string;
  sessionId: string;
  /** True when the `<sessionId>/` tool-results sidecar dir was present + copied. */
  sidecar: boolean;
}

interface BackupManifest {
  createdAt: string;
  bundleId: string;
  schemaVersion: 1;
  /** "selective" = curated set; "full" = whole-dir migration bundle. */
  mode: "selective" | "full";
  postgresDumpSha256: string;
  fridayVersion: string;
  files: ManifestFileEntry[];
  /** Claude SDK sessions captured (full mode only; empty otherwise). */
  claudeSessions: ClaudeSessionEntry[];
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
    full: {
      type: "boolean",
      description: "Complete migration bundle: whole ~/.friday (incl .git) + Claude SDK sessions",
    },
    "include-age-key": {
      type: "boolean",
      description: "Include .age-key in the bundle (off by default; makes it non-distributable)",
    },
  },
  async run({ args }) {
    const full = !!args.full;
    const includeAgeKey = !!args["include-age-key"];
    const outputPath = resolveOutputPath(args.output);
    mkdirSync(dirname(outputPath), { recursive: true });

    console.log(pc.bold(`Friday backup${full ? " (full)" : ""} → ${outputPath}`));

    const stageDir = await mkdtemp(join(tmpdir(), "friday-backup-"));
    try {
      // 1. pg_dump → postgres.dump (custom format, single file).
      const dumpPath = join(stageDir, "postgres.dump");
      const pgDump = spawnSync(
        findPgBin("pg_dump"),
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

      // 2. Filesystem capture + age-key handling.
      let fileInventory: ManifestFileEntry[];
      let claudeSessions: ClaudeSessionEntry[] = [];

      if (full) {
        fileInventory = stageFullDataDir(stageDir, includeAgeKey);
        claudeSessions = await captureClaudeSessions(stageDir);
        if (includeAgeKey) {
          console.log(
            pc.yellow(
              "  .age-key included — this bundle is NOT safe to distribute (treat as a password).",
            ),
          );
        } else {
          console.log(
            pc.yellow(
              "  .age-key NOT included — secrets/vault.enc won't decrypt on the target. For a migration add --include-age-key (or copy ~/.friday/.age-key separately).",
            ),
          );
        }
      } else {
        fileInventory = stageSelective(stageDir, includeAgeKey);
      }

      // 3. manifest.json (sanity + restore-time verification anchor).
      const manifest: BackupManifest = {
        createdAt: new Date().toISOString(),
        bundleId: randomUUID(),
        schemaVersion: 1,
        mode: full ? "full" : "selective",
        postgresDumpSha256: dumpSha,
        fridayVersion: pkg.version,
        files: fileInventory,
        claudeSessions,
      };
      writeFileSync(join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

      // 4. tar+gz the staged contents.
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
      if (full) {
        console.log(
          pc.dim(`  ${claudeSessions.length} claude session(s) · whole ~/.friday (incl .git)`),
        );
      }
      console.log(pc.dim(`  bundle ${manifest.bundleId}`));
    } finally {
      await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
  },
});

/** Selective (default) capture: the curated BACKUP_PATHS + optional .age-key. */
function stageSelective(stageDir: string, includeAgeKey: boolean): ManifestFileEntry[] {
  const inventory: ManifestFileEntry[] = [];
  if (includeAgeKey) {
    copyAgeKey(stageDir);
  } else if (existsSync(join(DATA_DIR, "secrets", "vault.enc"))) {
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
    inventory.push({ path: rel, exists });
    if (!exists) continue;
    const dest = join(stageDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpR(abs, dest, rel);
  }
  return inventory;
}

/** Full capture: the WHOLE ~/.friday minus regenerable/machine-tied bulk. */
function stageFullDataDir(stageDir: string, includeAgeKey: boolean): ManifestFileEntry[] {
  const inventory: ManifestFileEntry[] = [];
  for (const entry of readdirSync(DATA_DIR)) {
    if (FULL_EXCLUDE.has(entry)) continue;
    if (entry === ".age-key" && !includeAgeKey) continue;
    const abs = join(DATA_DIR, entry);
    cpR(abs, join(stageDir, entry), entry);
    inventory.push({ path: entry, exists: true });
  }
  return inventory;
}

/** Copy the Claude SDK session transcript + sidecar for every non-archived
 *  agent that has a session, keyed by agent name under `claude-sessions/`. */
async function captureClaudeSessions(stageDir: string): Promise<ClaudeSessionEntry[]> {
  const db = getDb();
  const rows = await db
    .select({
      name: schema.agents.name,
      type: schema.agents.type,
      sessionId: schema.agents.sessionId,
      worktreePath: schema.agents.worktreePath,
    })
    .from(schema.agents)
    .where(ne(schema.agents.status, "archived"));

  const out: ClaudeSessionEntry[] = [];
  for (const r of rows) {
    if (!r.sessionId) continue;
    const cwd = agentCwd(r);
    const jsonl = sessionFilePath(cwd, r.sessionId);
    if (!existsSync(jsonl)) continue; // session never wrote a transcript yet
    const dest = join(stageDir, "claude-sessions", r.name);
    mkdirSync(dest, { recursive: true });
    cpR(jsonl, join(dest, `${r.sessionId}.jsonl`), `session ${r.name}`);
    const sidecar = sessionSidecarDir(cwd, r.sessionId);
    const hasSidecar = existsSync(sidecar);
    if (hasSidecar) cpR(sidecar, join(dest, r.sessionId), `session-sidecar ${r.name}`);
    out.push({ agent: r.name, type: r.type, sessionId: r.sessionId, sidecar: hasSidecar });
    console.log(pc.dim(`  claude session: ${r.name} (${r.sessionId.slice(0, 8)}…)`));
  }
  return out;
}

/** Resolve an agent's working dir (= its `~/.claude/projects` cwd). Builders use
 *  their worktree; everything else its per-agent home `~/.friday/agents/<name>`. */
function agentCwd(r: { name: string; type: string; worktreePath: string | null }): string {
  if (r.type === "builder" && r.worktreePath) return r.worktreePath;
  return join(DATA_DIR, "agents", r.name);
}

function copyAgeKey(stageDir: string): void {
  const ageKey = join(DATA_DIR, ".age-key");
  if (!existsSync(ageKey)) return;
  cpR(ageKey, join(stageDir, ".age-key"), ".age-key");
  console.log(pc.yellow("  .age-key included — protect this bundle like a password"));
}

/** `cp -R` via the system binary (handles symlinks/permissions natively). */
function cpR(src: string, dest: string, label: string): void {
  const cp = spawnSync("cp", ["-R", src, dest], { stdio: ["ignore", "inherit", "inherit"] });
  if (cp.status !== 0) throw new Error(`Failed to copy ${label} into staging directory.`);
}

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
