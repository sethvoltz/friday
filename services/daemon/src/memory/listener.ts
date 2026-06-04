/**
 * Phase 4.5 — memory_entries LISTEN handler + boot-recovery scan.
 *
 * The `createMemoryEntry` / `updateMemoryEntry` / `deleteMemoryEntry`
 * mutators write only Postgres state (status='pending_file' or
 * 'pending_delete'); this module owns the filesystem side. A Postgres
 * trigger (added by migration `0004_memory_notify_trigger.sql`) fires
 * `NOTIFY friday_memory_file_changed` with `NEW.id` as the payload
 * after every INSERT/UPDATE where the row's status entered a pending
 * state. The handler:
 *
 *   - status='pending_file': read the row, write
 *     `~/.friday/memory/entries/<id>.md` (markdown w/ YAML
 *     frontmatter), update file_mtime, flip status='ready'.
 *
 *   - status='pending_delete': move the file to
 *     `~/.friday/memory/trash/<id>.md` (preserving so a future
 *     undelete can restore), flip status='deleted' (tombstone — the
 *     row stays so multi-device sync converges; the dashboard's
 *     reactive query filters status NOT IN ('pending_delete',
 *     'deleted')).
 *
 * Boot-recovery scan (plan §5): on daemon boot, scan
 * `memory_entries WHERE status IN ('pending_file', 'pending_delete')`
 * and apply the same handler — catches changes that landed while the
 * daemon was down.
 *
 * Idempotency: the handler is safe to re-run on the same row. Writing
 * the file is deterministic on (id, content, tags, title); moving to
 * trash is idempotent (rename a non-existent path is a no-op handled
 * inside the move helper).
 */

import { eq, inArray } from "drizzle-orm";
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pgPkg from "pg";
import {
  ensureDirs,
  getDb,
  getPool,
  loadFridayConfig,
  MEMORY_DIR,
  MEMORY_ENTRIES_DIR,
  schema,
  LISTEN_CHANNELS,
} from "@friday/shared";
import { serializeEntry, type MemoryEntry } from "@friday/memory";
import { logger } from "../log.js";

const { Client } = pgPkg;

const MEMORY_TRASH_DIR = join(MEMORY_DIR, "trash");

function entryPath(id: string): string {
  return join(MEMORY_ENTRIES_DIR, `${id}.md`);
}

function trashPath(id: string): string {
  return join(MEMORY_TRASH_DIR, `${id}.md`);
}

function ensureMemoryDirs(): void {
  ensureDirs();
  if (!existsSync(MEMORY_ENTRIES_DIR)) {
    mkdirSync(MEMORY_ENTRIES_DIR, { recursive: true });
  }
  if (!existsSync(MEMORY_TRASH_DIR)) {
    mkdirSync(MEMORY_TRASH_DIR, { recursive: true });
  }
}

/**
 * Process a single pending row. Idempotent on row state — a
 * duplicate notification or boot-recovery re-scan re-runs the same
 * work without breaking anything.
 */
async function processPendingMemoryRow(id: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.memoryEntries)
    .where(eq(schema.memoryEntries.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    // Row vanished between notification and handler — nothing to do.
    return;
  }

  if (row.status === "pending_file") {
    ensureMemoryDirs();
    const path = entryPath(row.id);
    // Reuse the canonical serializer from @friday/memory so the
    // file shape matches MCP `memory_save`'s output exactly.
    const entry: MemoryEntry = {
      id: row.id,
      title: row.title,
      content: row.content,
      tags: Array.isArray(row.tagsJson) ? (row.tagsJson as string[]) : [],
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      recallCount: row.recallCount,
      lastRecalledAt: row.lastRecalledAt ? row.lastRecalledAt.toISOString() : null,
    };
    writeFileSync(path, serializeEntry(entry));
    const fileMtime = new Date(statSync(path).mtimeMs);
    await db
      .update(schema.memoryEntries)
      .set({ status: "ready", fileMtime })
      .where(eq(schema.memoryEntries.id, id));
    logger.log("info", "memory.sync.file-written", { id, path });
    return;
  }

  if (row.status === "pending_delete") {
    ensureMemoryDirs();
    const src = entryPath(row.id);
    const dst = trashPath(row.id);
    if (existsSync(src)) {
      // Overwrite any prior trashed file with the same id — the
      // user is asserting "delete this version too".
      if (existsSync(dst)) rmSync(dst);
      renameSync(src, dst);
    }
    await db
      .update(schema.memoryEntries)
      .set({ status: "deleted" })
      .where(eq(schema.memoryEntries.id, id));
    logger.log("info", "memory.sync.file-trashed", { id, dst });
    return;
  }

  // Any other status (ready, deleted) — nothing to do. Either
  // already applied or terminal.
}

/**
 * Boot-recovery scan: pick up any pending rows that the daemon
 * missed (daemon down while a dashboard mutator landed). Same
 * predicate as the LISTEN trigger so the contract is symmetric.
 */
export async function runMemoryBootScan(): Promise<void> {
  try {
    const db = getDb();
    const rows = await db
      .select({ id: schema.memoryEntries.id })
      .from(schema.memoryEntries)
      .where(inArray(schema.memoryEntries.status, ["pending_file", "pending_delete"]));
    for (const row of rows) {
      await processPendingMemoryRow(row.id);
    }
    logger.log("info", "memory.boot-scan.complete", { processed: rows.length });
  } catch (err) {
    logger.log("warn", "memory.boot-scan.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface MemoryListenerHandle {
  stop: () => Promise<void>;
}

// Readiness gate for the memory LISTEN connection.
//
// Starts as a pre-resolved promise so that contexts where
// startMemoryListener() is never called (test suites, pre-listener
// boot window before the server receives its first request) fail open
// immediately rather than hanging for the 3-second timeout. Replaced
// with a real deferred inside startMemoryListener() before any async
// work begins, so recall attempts that arrive after the HTTP server
// starts but before LISTEN succeeds will wait — and time out and fail
// open — rather than producing spurious errors against an incomplete
// memory state.
let _readyResolve: (() => void) | null = null;
let _readyPromise: Promise<void> = Promise.resolve();

/** Returns a promise that resolves once startMemoryListener() has successfully issued LISTEN. */
export function whenMemoryListenerReady(): Promise<void> {
  return _readyPromise;
}

/**
 * Start the long-lived LISTEN connection for
 * `friday_memory_file_changed`. Dedicated `pg.Client` for the same
 * reason as the settings listener — pooled connections rotate and
 * silently drop subscriptions.
 */
export async function startMemoryListener(): Promise<MemoryListenerHandle> {
  // Replace the pre-resolved default with a real deferred so any recall
  // that races the async setup below will wait (or time out and fail open).
  _readyPromise = new Promise<void>((resolve) => {
    _readyResolve = resolve;
  });

  const pool = getPool();
  const connectionString =
    (pool.options as { connectionString?: string }).connectionString ??
    loadFridayConfig().databaseUrl;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set to start the memory LISTEN connection.");
  }

  let stopped = false;
  let activeClient: InstanceType<typeof Client> | null = null;

  // FRI-121 B: reconnect loop with keepAlive + exponential backoff.
  // _readyResolve is called on the first successful LISTEN; subsequent
  // reconnects leave _readyPromise already-resolved so callers aren't
  // re-blocked.
  async function connectWithRetry(): Promise<void> {
    let delay = 1_000;
    while (!stopped) {
      try {
        const c = new Client({ connectionString, keepAlive: true });
        activeClient = c;
        await c.connect();
        c.on("notification", (msg) => {
          if (msg.channel !== LISTEN_CHANNELS.memoryFileChanged) return;
          const id = msg.payload;
          if (!id) return;
          void processPendingMemoryRow(id).catch((err) => {
            logger.log("warn", "memory.listen.process.error", {
              id,
              message: err instanceof Error ? err.message : String(err),
            });
          });
        });
        c.on("error", (err) => {
          logger.log("warn", "memory.listen.client.error", {
            message: err instanceof Error ? err.message : String(err),
          });
        });
        await c.query(`LISTEN ${LISTEN_CHANNELS.memoryFileChanged}`);
        _readyResolve?.();
        _readyResolve = null;
        logger.log("info", "memory.listen.ready", {
          channel: LISTEN_CHANNELS.memoryFileChanged,
        });
        await runMemoryBootScan();
        delay = 1_000;
        await new Promise<void>((resolve) => c.once("end", resolve));
      } catch (err) {
        logger.log("warn", "memory.listen.connect.error", {
          message: err instanceof Error ? err.message : String(err),
          retryIn: delay,
        });
        if (!stopped) {
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, 30_000);
        }
      } finally {
        activeClient = null;
      }
    }
  }

  void connectWithRetry();

  return {
    stop: async (): Promise<void> => {
      stopped = true;
      if (activeClient) {
        try {
          await activeClient.query(`UNLISTEN ${LISTEN_CHANNELS.memoryFileChanged}`);
        } catch {
          // best-effort
        }
        await activeClient.end().catch(() => {});
      }
    },
  };
}
