/**
 * `friday export-legacy-sqlite <output-path>` — one-shot migration tool
 * that reads a pre-Postgres `db.sqlite` and writes a portable bundle
 * shaped like `friday backup` output, but with rows as JSON instead of
 * pg_dump. `friday restore` detects the bundle type via manifest and
 * branches into the JSON-row import path.
 *
 * Plan §246–§253:
 *   - Default source: `~/.friday/db.sqlite.pre-postgres.bak`. Override
 *     with `--source <path>`.
 *   - Column conversions:
 *       * SQLite integer-ms `ts` → ISO string (Postgres timestamptz
 *         can parse the ISO at import time).
 *       * SQLite text JSON in `content_json`, `meta_json`, `tags_json`,
 *         etc. → parsed object literals (re-stringified to jsonb at
 *         import).
 *       * FTS5 virtual tables are NOT exported — the destination
 *         schema's generated `tsvector` columns recompute from the
 *         row text after INSERT.
 *   - Block filter: rows with `status='streaming'` are dropped (the
 *     daemon's restart-recovery would otherwise re-import partial
 *     bytes that aren't safe to render).
 *   - Table filter: the retired `turns` table (ADR-016) is not
 *     exported.
 *   - Filesystem snapshot: same `BACKUP_PATHS` set as `friday backup`
 *     (.env, SOUL, config, skills, memory/entries, evolve/proposals,
 *     apps, schedules, uploads) so the resulting bundle restores into
 *     a full Friday install.
 *   - Atomic: stages in a tempdir, tar → .tmp, rename on success.
 */

import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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

/** Tables we export, in dependency order (parents before children for
 *  FK-aware importers; the row-by-row Postgres importer is FK-agnostic
 *  but this order also gives a sane debug log progression). */
const EXPORT_TABLES = [
  "user",
  "account",
  "session",
  "verification",
  "agents",
  "tickets",
  "ticket_comments",
  "ticket_relations",
  "ticket_external_links",
  "blocks",
  "mail",
  "memory_entries",
  "schedules",
  "apps",
  "attachments",
  "usage",
  "db_meta",
] as const;

/** Tables we never export. `turns` was retired in ADR-016; FTS5
 *  virtual tables recompute from row content at import time. */
const SKIP_TABLES = new Set<string>(["turns"]);

/** Columns whose SQLite text is JSON-encoded and should be inflated to
 *  an object/array in the bundle. Keyed by `<table>.<column>`. */
const JSON_COLUMNS = new Set<string>([
  "blocks.content_json",
  "mail.meta_json",
  "memory_entries.tags_json",
  "tickets.meta_json",
  "ticket_external_links.meta_json",
  "schedules.meta_json",
  "agents.meta_json",
  "apps.manifest_json",
  "apps.meta_json",
]);

/** Columns whose SQLite integer milliseconds should be ISO-stringified
 *  for the Postgres `timestamptz` import. */
const TIMESTAMP_COLUMNS = new Set<string>([
  "blocks.ts",
  "mail.ts",
  "mail.read_at",
  "mail.closed_at",
  "memory_entries.created_at",
  "memory_entries.updated_at",
  "memory_entries.file_mtime",
  "memory_entries.last_recalled_at",
  "tickets.created_at",
  "tickets.updated_at",
  "ticket_comments.ts",
  "ticket_external_links.linked_at",
  "schedules.next_run_at",
  "schedules.last_run_at",
  "schedules.created_at",
  "schedules.updated_at",
  "agents.created_at",
  "agents.updated_at",
  "apps.installed_at",
  "apps.upgraded_at",
  "attachments.created_at",
  "user.created_at",
  "user.updated_at",
  "user.email_verified",
  "session.expires_at",
  "session.created_at",
  "session.updated_at",
  "account.access_token_expires_at",
  "account.refresh_token_expires_at",
  "account.created_at",
  "account.updated_at",
  "verification.expires_at",
  "verification.created_at",
  "verification.updated_at",
]);

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

interface ExportManifest {
  createdAt: string;
  bundleId: string;
  /** `legacy_sqlite` distinguishes from `pg_dump` bundles produced by
   *  `friday backup`. `friday restore` reads this to pick the import
   *  path. */
  bundleType: "legacy_sqlite";
  /** Bumped when the export format changes. */
  schemaVersion: 1;
  /** Source DB path on the machine that produced this bundle. */
  source: string;
  /** Per-table row count + SHA-256 of the table's JSON file. Lets the
   *  importer verify the bundle landed completely. */
  tables: Array<{ name: string; rowCount: number; sha256: string }>;
  /** Same filesystem-inventory shape as `friday backup`. */
  files: Array<{ path: string; exists: boolean }>;
}

export const exportLegacySqliteCommand = defineCommand({
  meta: {
    name: "export-legacy-sqlite",
    description:
      "Export a pre-Postgres SQLite database to a portable JSON+filesystem bundle for restore into a new Postgres install.",
  },
  args: {
    output: {
      type: "positional",
      description:
        "Output path for the tarball (default: ~/.friday/backups/legacy-<ts>.tar.gz).",
      required: false,
    },
    source: {
      type: "string",
      description:
        "Path to the SQLite database (default: ~/.friday/db.sqlite.pre-postgres.bak).",
    },
  },
  async run({ args }) {
    const sourcePath =
      typeof args.source === "string" && args.source.length > 0
        ? args.source
        : join(DATA_DIR, "db.sqlite.pre-postgres.bak");
    if (!existsSync(sourcePath)) {
      console.error(
        pc.red(
          `✗ source SQLite database not found: ${sourcePath}\n  Pass --source to override, or rename your db.sqlite to db.sqlite.pre-postgres.bak.`,
        ),
      );
      process.exit(1);
    }

    const outputPath = resolveOutputPath(args.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    console.log(pc.bold(`Friday legacy export → ${outputPath}`));
    console.log(pc.dim(`  source ${sourcePath}`));

    const stageDir = await mkdtemp(join(tmpdir(), "friday-export-"));
    try {
      // 1. Per-table JSON dumps. `sqlite3 -json` gives us a parseable
      //    array; we apply column conversions in-memory and write a
      //    one-row-per-line NDJSON file for streaming-friendly import.
      const rowsDir = join(stageDir, "rows");
      mkdirSync(rowsDir, { recursive: true });
      const tableManifests: ExportManifest["tables"] = [];
      for (const table of EXPORT_TABLES) {
        if (SKIP_TABLES.has(table)) continue;
        if (!tableExists(sourcePath, table)) {
          console.log(pc.dim(`  ${table.padEnd(24)} skipped (not in source)`));
          continue;
        }
        const where = table === "blocks" ? " WHERE status != 'streaming'" : "";
        const raw = spawnSync(
          "sqlite3",
          ["-json", sourcePath, `SELECT * FROM "${table}"${where}`],
          { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
        );
        if (raw.status !== 0) {
          throw new Error(
            `sqlite3 export of "${table}" failed with status ${raw.status}: ${raw.stderr}`,
          );
        }
        const rows = raw.stdout.trim().length > 0
          ? (JSON.parse(raw.stdout) as Array<Record<string, unknown>>)
          : [];
        const converted = rows.map((r) => convertRow(table, r));
        const ndjson = converted.map((r) => JSON.stringify(r)).join("\n");
        const filePath = join(rowsDir, `${table}.ndjson`);
        writeFileSync(filePath, ndjson + (ndjson.length > 0 ? "\n" : ""));
        const sha = createHash("sha256").update(ndjson).digest("hex");
        tableManifests.push({ name: table, rowCount: converted.length, sha256: sha });
        console.log(
          pc.dim(
            `  ${table.padEnd(24)} ${String(converted.length).padStart(6)} rows  ${sha.slice(0, 12)}…`,
          ),
        );
      }

      // 2. Filesystem snapshot (same as friday backup).
      const fileInventory: ExportManifest["files"] = [];
      for (const rel of BACKUP_PATHS) {
        const abs = join(DATA_DIR, rel);
        const exists = existsSync(abs);
        fileInventory.push({ path: rel, exists });
        if (!exists) continue;
        const dest = join(stageDir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        const cp = spawnSync("cp", ["-R", abs, dest], {
          stdio: ["ignore", "inherit", "inherit"],
        });
        if (cp.status !== 0) {
          throw new Error(`Failed to copy ${rel} into staging directory.`);
        }
      }

      // 3. Write manifest.
      const manifest: ExportManifest = {
        createdAt: new Date().toISOString(),
        bundleId: randomUUID(),
        bundleType: "legacy_sqlite",
        schemaVersion: 1,
        source: sourcePath,
        tables: tableManifests,
        files: fileInventory,
      };
      writeFileSync(
        join(stageDir, "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
      );

      // 4. Tarball with atomic rename.
      const tmpOutput = outputPath + ".tmp";
      if (existsSync(tmpOutput)) unlinkSync(tmpOutput);
      const tar = spawnSync(
        "tar",
        ["-czf", tmpOutput, "-C", stageDir, "."],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      if (tar.status !== 0) {
        throw new Error(`tar exited with status ${tar.status}.`);
      }
      renameSync(tmpOutput, outputPath);

      const totalRows = tableManifests.reduce((s, t) => s + t.rowCount, 0);
      console.log(
        pc.green(
          `✓ export complete · ${formatBytes(statSync(outputPath).size)} · ${totalRows} rows across ${tableManifests.length} tables`,
        ),
      );
      console.log(pc.dim(`  bundle ${manifest.bundleId}`));
    } finally {
      await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
  },
});

function tableExists(dbPath: string, table: string): boolean {
  const res = spawnSync(
    "sqlite3",
    [
      "-json",
      dbPath,
      `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}' LIMIT 1`,
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) return false;
  return res.stdout.trim().length > 0 && res.stdout !== "[]";
}

function convertRow(
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [col, raw] of Object.entries(row)) {
    const key = `${table}.${col}`;
    if (TIMESTAMP_COLUMNS.has(key) && raw !== null && raw !== undefined) {
      // SQLite stores ts as integer milliseconds since epoch.
      const ms = typeof raw === "number" ? raw : Number(raw);
      out[col] = Number.isFinite(ms) ? new Date(ms).toISOString() : raw;
      continue;
    }
    if (JSON_COLUMNS.has(key) && typeof raw === "string") {
      try {
        out[col] = JSON.parse(raw);
        continue;
      } catch {
        // Leave the raw string in; the importer can decide how to
        // handle un-parseable JSON (probably fail loudly).
      }
    }
    out[col] = raw;
  }
  return out;
}

function resolveOutputPath(arg: unknown): string {
  if (typeof arg === "string" && arg.length > 0) return arg;
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/T/, "_")
    .replace(/Z$/, "");
  return join(DATA_DIR, "backups", `legacy-${ts}.tar.gz`);
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

