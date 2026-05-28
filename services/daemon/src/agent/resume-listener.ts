/**
 * FRI-123 — resumeTurn LISTEN handler + boot-recovery scan.
 *
 * The `resumeTurn` Zero mutator UPDATEs the user block's status
 * from 'complete' to 'resume_requested'. A Postgres trigger
 * (migration `0023_block_resume_notify_trigger.sql`) fires
 * `NOTIFY friday_resume_requested` with the row's `block_id` as
 * payload; this handler:
 *
 *   1. Reads the block row by id and validates (status still
 *      'resume_requested', role=user, kind=text). Idempotent
 *      against re-runs: a row already flipped back to 'complete'
 *      short-circuits at the status check.
 *   2. Resolves the target agent + checks no live turn is currently
 *      in flight for this agent (the resume re-uses the failed
 *      turn's id; dispatching twice under the same id would race).
 *   3. Parses `userText` from the block's content_json.
 *   4. Calls `buildDispatchPrompt(agentRow, { kind: 'user_chat',
 *      userText })` — same identity, same pinned facts, same recall +
 *      skill-context hook surface as a fresh user turn.
 *   5. Calls `dispatchTurn` re-using the original `turnId` so the
 *      retry's content blocks visually group with the original
 *      error bubble (FRI-12 contract). Does NOT insert a new user
 *      block — the original user block is the prompt origin.
 *   6. UPDATEs the row back to status='complete' so the trigger
 *      doesn't re-fire on subsequent unrelated UPDATEs.
 *
 * Boot-recovery scan: on daemon boot, scan
 * `blocks WHERE status='resume_requested'` and apply the same
 * handler — catches resumes that landed while the daemon was
 * down. Runs after `runArchiveBootScan` and before
 * `recoverQueuedTurns` so a resume that landed mid-shutdown
 * re-fires on the existing turnId before queue replay.
 *
 * Replaces the retired `POST /api/chat/turn/<id>/resume` REST path
 * (ADR-024 retirement set; deleted in the same PR that added this
 * handler).
 */

import { eq } from "drizzle-orm";
import pgPkg from "pg";
import {
  getDb,
  getPool,
  loadConfig,
  normalizeModelConfig,
  resolveDaemonPort,
  schema,
  LISTEN_CHANNELS,
} from "@friday/shared";
import { getBlockById } from "@friday/shared/services";
import * as registry from "./registry.js";
import { dispatchTurn, findAgentByTurnId, peekLiveWorker } from "./lifecycle.js";
import { buildDispatchPrompt } from "../prompts/build-dispatch-prompt.js";
import { logger } from "../log.js";

const { Client } = pgPkg;

/**
 * Process a single block row that's been flipped to
 * status='resume_requested'. Idempotent — re-running on a row
 * that's already been flipped back to 'complete' (or where the
 * agent is already mid-turn) is a no-op.
 */
async function processResumeRequestedRow(blockId: string): Promise<void> {
  const row = await getBlockById(blockId);
  if (!row) {
    // Row deleted out from under us. Nothing to do.
    return;
  }
  if (row.status !== "resume_requested") {
    // Status moved on (handler ran already, or another path
    // overwrote it). No-op.
    return;
  }
  if (row.role !== "user" || row.kind !== "text") {
    logger.log("warn", "block.resume.skip.shape-mismatch", {
      block_id: row.blockId,
      role: row.role,
      kind: row.kind,
    });
    // Flip back so the trigger doesn't keep firing on this row.
    await flipBackToComplete(blockId);
    return;
  }

  const agentName = row.agentName;
  const turnId = row.turnId;

  // Guard: don't double-dispatch under the same turnId. If a
  // resume re-fires while the previous re-dispatch is still
  // running, leave the row marked and let the next post-turn
  // boot scan retry — the listener bails here without flipping
  // back, so the row stays at 'resume_requested' until the
  // in-flight turn finishes and the user re-clicks.
  if (findAgentByTurnId(turnId)) {
    logger.log("warn", "block.resume.skip.turn-in-flight", {
      block_id: blockId,
      turn_id: turnId,
      agent: agentName,
    });
    await flipBackToComplete(blockId);
    return;
  }

  const agentRow = await registry.getAgent(agentName);
  if (!agentRow) {
    logger.log("warn", "block.resume.skip.no-agent", {
      block_id: blockId,
      agent: agentName,
    });
    await flipBackToComplete(blockId);
    return;
  }

  const live = peekLiveWorker(agentName);
  if (live && live.status === "working") {
    logger.log("warn", "block.resume.skip.agent-busy", {
      block_id: blockId,
      agent: agentName,
    });
    await flipBackToComplete(blockId);
    return;
  }

  let userText = "";
  try {
    const parsed = JSON.parse(row.contentJson) as { text?: unknown };
    if (typeof parsed.text === "string") userText = parsed.text;
  } catch {
    logger.log("warn", "block.resume.skip.content-corrupt", {
      block_id: blockId,
      turn_id: turnId,
    });
    await flipBackToComplete(blockId);
    return;
  }
  if (!userText.trim()) {
    logger.log("warn", "block.resume.skip.empty-text", {
      block_id: blockId,
      turn_id: turnId,
    });
    await flipBackToComplete(blockId);
    return;
  }

  const {
    body: dispatchBody,
    systemPrompt,
    allowedToolsOverride,
  } = await buildDispatchPrompt(agentRow, { kind: "user_chat", userText });

  const cfg = loadConfig();
  const modelCfg = normalizeModelConfig(cfg.model);
  const resumeCwd = await registry.workingDirectoryFor(agentRow);
  dispatchTurn({
    agentName,
    options: {
      agentName,
      agentType: agentRow.type,
      workingDirectory: resumeCwd,
      systemPrompt,
      prompt: dispatchBody,
      turnId, // <-- reuse the failed turn's id (FRI-12 contract)
      model: modelCfg.name,
      thinking: modelCfg.thinking,
      effort: modelCfg.effort,
      resumeSessionId: agentRow.sessionId ?? undefined,
      daemonPort: resolveDaemonPort(cfg),
      parentName: "parentName" in agentRow ? (agentRow.parentName ?? undefined) : undefined,
      mode: agentRow.type === "scheduled" ? "one-shot" : "long-lived",
      allowedToolsOverride,
    },
  });

  await flipBackToComplete(blockId);

  logger.log("info", "block.resume.applied", {
    block_id: blockId,
    agent: agentName,
    turn_id: turnId,
  });
}

async function flipBackToComplete(blockId: string): Promise<void> {
  const db = getDb();
  await db
    .update(schema.blocks)
    .set({ status: "complete" })
    .where(eq(schema.blocks.blockId, blockId));
}

export async function runResumeBootScan(): Promise<void> {
  try {
    const db = getDb();
    const rows = await db
      .select({ blockId: schema.blocks.blockId })
      .from(schema.blocks)
      .where(eq(schema.blocks.status, "resume_requested"));
    for (const row of rows) {
      await processResumeRequestedRow(row.blockId);
    }
    logger.log("info", "block.resume-boot-scan.complete", {
      processed: rows.length,
    });
  } catch (err) {
    logger.log("warn", "block.resume-boot-scan.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface ResumeListenerHandle {
  stop: () => Promise<void>;
}

export async function startResumeListener(): Promise<ResumeListenerHandle> {
  const pool = getPool();
  const connectionString =
    (pool.options as { connectionString?: string }).connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set to start the resumeTurn LISTEN connection.");
  }

  let stopped = false;
  let activeClient: InstanceType<typeof Client> | null = null;

  // Mirror abort-listener: reconnect loop with keepAlive + exponential backoff.
  async function connectWithRetry(): Promise<void> {
    let delay = 1_000;
    while (!stopped) {
      try {
        const c = new Client({ connectionString, keepAlive: true });
        activeClient = c;
        await c.connect();
        c.on("notification", (msg) => {
          if (msg.channel !== LISTEN_CHANNELS.resumeRequested) return;
          const blockId = msg.payload;
          if (!blockId) return;
          void processResumeRequestedRow(blockId).catch((err) => {
            logger.log("warn", "block.resume-listen.process.error", {
              block_id: blockId,
              message: err instanceof Error ? err.message : String(err),
            });
          });
        });
        c.on("error", (err) => {
          logger.log("warn", "block.resume-listen.client.error", {
            message: err instanceof Error ? err.message : String(err),
          });
        });
        await c.query(`LISTEN ${LISTEN_CHANNELS.resumeRequested}`);
        logger.log("info", "block.resume-listen.ready", {
          channel: LISTEN_CHANNELS.resumeRequested,
        });
        await runResumeBootScan();
        delay = 1_000;
        await new Promise<void>((resolve) => c.once("end", resolve));
      } catch (err) {
        logger.log("warn", "block.resume-listen.connect.error", {
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
          await activeClient.query(`UNLISTEN ${LISTEN_CHANNELS.resumeRequested}`);
        } catch {
          // best-effort
        }
        await activeClient.end().catch(() => {});
      }
    },
  };
}

// Test-only export: lets `resume-listener.test.ts` drive the handler
// without spinning up the LISTEN connection.
export { processResumeRequestedRow as _processResumeRequestedRow };
