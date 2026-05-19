/**
 * Phase 4.9 — cancelQueued LISTEN handler + boot-recovery scan.
 *
 * The `cancelQueued` mutator UPDATEs a queued blocks row from
 * status='queued' to status='cancel_requested'. A Postgres trigger
 * (migration `0008_block_cancel_notify_trigger.sql`) fires
 * `NOTIFY friday_block_canceled` with the row's `block_id` as
 * payload; this handler:
 *
 *   1. Calls `removeQueuedPrompt(agent, turn)` — idempotent splice of
 *      the in-memory `nextPrompts` deque. If the fast-path
 *      (`POST /api/internal/cancel-queued`) already ran, this returns
 *      `null` and we move on.
 *   2. Publishes a `block_meta_update` SSE event (legacy non-Zero
 *      tabs read this to flip the queued bubble out of the chat).
 *   3. DELETEs the row from `blocks`. This is the canonical delete
 *      path — the fast-path intentionally leaves the row alone so
 *      the trigger has something to fire on.
 *
 * Boot-recovery scan (plan §5): on daemon boot, scan
 * `blocks WHERE status='cancel_requested'` and apply the same
 * handler — catches cancels that landed while the daemon was down
 * (mutator commit + replication, no LISTEN connection open to
 * receive the NOTIFY).
 */

import { eq } from "drizzle-orm";
import pgPkg from "pg";
import {
  getDb,
  getPool,
  schema,
  LISTEN_CHANNELS,
} from "@friday/shared";
import { deleteBlockById, getBlockById } from "@friday/shared/services";
import { removeQueuedPrompt } from "./lifecycle.js";
import { eventBus } from "../events/bus.js";
import { logger } from "../log.js";

const { Client } = pgPkg;

/**
 * Process a single block row that's been flipped to
 * status='cancel_requested'. Idempotent — re-running on a row that's
 * already been processed (row DELETEd) is a no-op.
 */
async function processCancelRequestedRow(blockId: string): Promise<void> {
  const row = await getBlockById(blockId);
  if (!row) {
    // Already processed (row DELETEd by a prior handler or by the
    // legacy REST DELETE path). No-op.
    return;
  }
  if (row.status !== "cancel_requested") {
    // Status moved on (e.g. legacy REST DELETE handled it inline and
    // its UPDATE→DELETE race left us reading the row mid-flight). The
    // trigger's predicate guarantees we only get NOTIFY on transition
    // INTO 'cancel_requested', but the row read here can still race —
    // bail out so we don't double-delete.
    return;
  }

  // Splice the in-memory nextPrompts deque. Idempotent: the fast-path
  // may have already done this — `removeQueuedPrompt` returns null in
  // that case and the side-effect is still correct (the prompt is
  // gone).
  const removed = removeQueuedPrompt(row.agentName, row.turnId);

  // Legacy SSE compatibility — non-Zero dashboard tabs receive
  // `block_meta_update` and flip the queued bubble out of the chat
  // accumulator. Publish BEFORE the DELETE so a late reconnecting
  // client sees the aborted state alongside the row vanish.
  eventBus.publish({
    v: 1,
    type: "block_meta_update",
    turn_id: row.turnId,
    agent: row.agentName,
    block_id: row.blockId,
    status: "aborted",
  });

  await deleteBlockById(row.blockId);

  logger.log("info", "block.cancel.applied", {
    block_id: row.blockId,
    agent: row.agentName,
    turn_id: row.turnId,
    spliced_in_memory: removed !== null,
  });
}

export async function runCancelBootScan(): Promise<void> {
  try {
    const db = getDb();
    const rows = await db
      .select({ blockId: schema.blocks.blockId })
      .from(schema.blocks)
      .where(eq(schema.blocks.status, "cancel_requested"));
    for (const row of rows) {
      await processCancelRequestedRow(row.blockId);
    }
    logger.log("info", "block.cancel-boot-scan.complete", {
      processed: rows.length,
    });
  } catch (err) {
    logger.log("warn", "block.cancel-boot-scan.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface CancelListenerHandle {
  stop: () => Promise<void>;
}

export async function startCancelListener(): Promise<CancelListenerHandle> {
  const pool = getPool();
  const connectionString =
    (pool.options as { connectionString?: string }).connectionString ??
    process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL must be set to start the cancelQueued LISTEN connection.",
    );
  }

  const client = new Client({ connectionString });
  await client.connect();

  client.on("notification", (msg) => {
    if (msg.channel !== LISTEN_CHANNELS.blockCancelRequested) return;
    const blockId = msg.payload;
    if (!blockId) return;
    void processCancelRequestedRow(blockId).catch((err) => {
      logger.log("warn", "block.cancel-listen.process.error", {
        block_id: blockId,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });

  client.on("error", (err) => {
    logger.log("warn", "block.cancel-listen.client.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  });

  await client.query(`LISTEN ${LISTEN_CHANNELS.blockCancelRequested}`);
  logger.log("info", "block.cancel-listen.ready", {
    channel: LISTEN_CHANNELS.blockCancelRequested,
  });

  return {
    stop: async (): Promise<void> => {
      try {
        await client.query(`UNLISTEN ${LISTEN_CHANNELS.blockCancelRequested}`);
      } catch {
        // best-effort
      }
      await client.end().catch(() => {});
    },
  };
}

// Test-only export: lets `cancel-listener.test.ts` drive the handler
// without spinning up the LISTEN connection.
export { processCancelRequestedRow as _processCancelRequestedRow };
