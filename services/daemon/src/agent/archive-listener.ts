/**
 * Phase 4.8 — archiveAgent LISTEN handler + boot-recovery scan.
 *
 * The `archiveAgent` mutator UPDATEs the agent row to
 * status='archive_requested' + archive_reason. A Postgres trigger
 * (added by migration `0007_agent_archive_notify_trigger.sql`)
 * fires `NOTIFY friday_archive_requested`; this handler reads the
 * row, calls the existing `archiveAgent(name, {reason})` lifecycle
 * function which:
 *   1. Stops the live worker (graceful → SIGTERM pgrp → SIGKILL).
 *   2. Archives the worktree to disk (builders only).
 *   3. Closes any linked Linear ticket.
 *   4. Sets status='archived' as its final write.
 *
 * Boot-recovery scan (plan §5): on daemon boot, scan
 * `agents WHERE status='archive_requested'` and apply the same
 * handler — catches archives that landed while the daemon was
 * down.
 *
 * Idempotency: re-archiving an already-'archived' agent is a no-op
 * inside the lifecycle code (worker gone, worktree archived, ticket
 * already closed). The handler only acts on rows still at
 * 'archive_requested'.
 */

import { eq, and } from "drizzle-orm";
import pgPkg from "pg";
import {
  type ArchiveReason,
  getDb,
  getPool,
  loadFridayConfig,
  schema,
  LISTEN_CHANNELS,
} from "@friday/shared";
import { archiveAgent } from "./lifecycle.js";
import { logger } from "../log.js";

const { Client } = pgPkg;

function parseReason(raw: string | null): ArchiveReason {
  // The mutator passes a known value, but the column is `text` so a
  // legacy / hand-crafted UPDATE could write anything. Normalize to
  // a safe default. The lifecycle code branches on the reason for
  // ticket-close behavior; an unknown value defaulting to
  // 'abandoned' matches the slash-command default.
  if (raw === "completed" || raw === "abandoned" || raw === "failed") {
    return raw;
  }
  return "abandoned";
}

async function processPendingArchiveRow(name: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.name, name), eq(schema.agents.status, "archive_requested")))
    .limit(1);
  const row = rows[0];
  if (!row) {
    // Already processed (status flipped to 'archived' by a prior
    // handler invocation or by a legacy direct-call path).
    return;
  }
  const reason = parseReason(row.archiveReason);
  try {
    await archiveAgent(name, { reason });
    logger.log("info", "agent.sync.archived", { name, reason });
  } catch (err) {
    logger.log("warn", "agent.sync.archive.error", {
      name,
      reason,
      message: err instanceof Error ? err.message : String(err),
    });
    // Leave the row at 'archive_requested' so boot-recovery / a
    // future retry can pick it up. Don't clobber to 'error' — the
    // dashboard's archive UI doesn't have an error-status display
    // path for agents (it would render as a broken ghost row).
  }
}

export async function runArchiveBootScan(): Promise<void> {
  try {
    const db = getDb();
    const rows = await db
      .select({ name: schema.agents.name })
      .from(schema.agents)
      .where(eq(schema.agents.status, "archive_requested"));
    for (const row of rows) {
      await processPendingArchiveRow(row.name);
    }
    logger.log("info", "agent.archive-boot-scan.complete", {
      processed: rows.length,
    });
  } catch (err) {
    logger.log("warn", "agent.archive-boot-scan.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface ArchiveListenerHandle {
  stop: () => Promise<void>;
}

export async function startArchiveListener(): Promise<ArchiveListenerHandle> {
  const pool = getPool();
  const connectionString =
    (pool.options as { connectionString?: string }).connectionString ??
    loadFridayConfig().databaseUrl;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set to start the archive LISTEN connection.");
  }

  let stopped = false;
  let activeClient: InstanceType<typeof Client> | null = null;

  // FRI-121 B: reconnect loop with keepAlive + exponential backoff.
  async function connectWithRetry(): Promise<void> {
    let delay = 1_000;
    while (!stopped) {
      try {
        const c = new Client({ connectionString, keepAlive: true });
        activeClient = c;
        await c.connect();
        c.on("notification", (msg) => {
          if (msg.channel !== LISTEN_CHANNELS.archiveRequested) return;
          const name = msg.payload;
          if (!name) return;
          void processPendingArchiveRow(name).catch((err) => {
            logger.log("warn", "agent.archive-listen.process.error", {
              name,
              message: err instanceof Error ? err.message : String(err),
            });
          });
        });
        c.on("error", (err) => {
          logger.log("warn", "agent.archive-listen.client.error", {
            message: err instanceof Error ? err.message : String(err),
          });
        });
        await c.query(`LISTEN ${LISTEN_CHANNELS.archiveRequested}`);
        logger.log("info", "agent.archive-listen.ready", {
          channel: LISTEN_CHANNELS.archiveRequested,
        });
        await runArchiveBootScan();
        delay = 1_000;
        await new Promise<void>((resolve) => c.once("end", resolve));
      } catch (err) {
        logger.log("warn", "agent.archive-listen.connect.error", {
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
          await activeClient.query(`UNLISTEN ${LISTEN_CHANNELS.archiveRequested}`);
        } catch {
          // best-effort
        }
        await activeClient.end().catch(() => {});
      }
    },
  };
}
