/**
 * Phase 4.11b — sendUserMessage LISTEN handler + boot-recovery scan.
 *
 * The `sendUserMessage` mutator INSERTs a user-chat block at
 * status='pending' (the discriminator — no daemon-internal write path
 * uses 'pending'). A Postgres trigger fires
 * `NOTIFY friday_new_pending_block` with the row's id as payload;
 * this handler:
 *
 *   1. Reads the block row by id.
 *   2. Resolves the target agent (registers as orchestrator if missing).
 *   3. Composes system prompt + detects skill invocation + wraps with
 *      memory recall — mirrors the legacy `POST /api/chat/turn` body.
 *   4. Peeks the live worker to decide queued-vs-immediate dispatch.
 *   5. UPDATEs the block row: `session_id` ← agent's resumed session,
 *      `status` ← 'queued' or 'complete'.
 *   6. Calls `dispatchTurn` to fork or queue the prompt.
 *
 * Boot-recovery scan (plan §5): on daemon boot, scan
 * `blocks WHERE status='pending' AND role='user'` and apply the same
 * handler — catches user messages that landed while the daemon was
 * down. Runs BEFORE `recoverQueuedTurns()` so the pending block
 * doesn't get re-handled by both code paths.
 *
 * Coexists with the legacy `POST /api/chat/turn` REST path (which
 * doesn't write 'pending' — it goes 'complete' or 'queued' directly
 * via `recordUserBlock`). The trigger predicate (NEW.status='pending')
 * means only mutator-initiated sends fire the LISTEN handler.
 */

import { and, eq } from "drizzle-orm";
import pgPkg from "pg";
import {
  getDb,
  getPool,
  LISTEN_CHANNELS,
  loadConfig,
  loadFridayConfig,
  normalizeModelConfig,
  resolveDaemonPort,
  schema,
} from "@friday/shared";
import { getBlockById } from "@friday/shared/services";
import * as registry from "./registry.js";
import { dispatchTurn, peekLiveWorker } from "./lifecycle.js";
import { buildDispatchPrompt } from "../prompts/build-dispatch-prompt.js";
import { matchSkillInvocation } from "../skills/match.js";
import { logger } from "../log.js";
import { captureFor } from "../posthog.js";

const { Client } = pgPkg;

/**
 * Run the full chat-turn dispatch for a pending user block. Mirrors
 * the legacy `POST /api/chat/turn` body but is driven by an existing
 * row (the mutator already INSERTed it) instead of an HTTP request.
 *
 * Idempotent — re-running on a row whose status has already flipped
 * to 'complete' / 'queued' is a no-op (the row read short-circuits).
 */
async function processPendingBlockRow(id: string): Promise<void> {
  const db = getDb();
  const row = await getBlockById(id);
  if (!row) {
    // Row was DELETEd (e.g. via the cancelQueued path) between the
    // NOTIFY and the handler read. Nothing to do.
    return;
  }
  if (row.status !== "pending") {
    // Already handled by a prior dispatch or boot-scan invocation.
    return;
  }
  if (row.role !== "user" || row.source !== "user_chat") {
    // Defensive: the mutator is the only writer to 'pending' for
    // user-chat. Any other shape is a bug; log and skip rather
    // than mis-dispatching.
    logger.log("warn", "block.dispatch.skip.shape-mismatch", {
      block_id: row.blockId,
      role: row.role,
      source: row.source,
    });
    return;
  }

  // Parse the user's text + attachments out of the row's content_json.
  // The mutator stored it as a structured object; rowFromDb stringifies
  // it for stable API shape.
  let userText = "";
  let attachments: Array<{ sha256: string; filename: string; mime: string }> | undefined;
  try {
    const parsed = JSON.parse(row.contentJson) as {
      text?: unknown;
      attachments?: unknown;
    };
    if (typeof parsed.text === "string") userText = parsed.text;
    if (Array.isArray(parsed.attachments)) {
      attachments = parsed.attachments.filter(
        (a): a is { sha256: string; filename: string; mime: string } =>
          a !== null &&
          typeof a === "object" &&
          typeof (a as { sha256?: unknown }).sha256 === "string" &&
          /^[a-f0-9]{64}$/.test((a as { sha256: string }).sha256),
      );
    }
  } catch {
    // Malformed content_json — daemon takes "no text, no attachments"
    // path. The worker fork still happens (in case the user is
    // signaling something) but with an empty prompt.
  }

  const cfg = loadConfig();
  const agentName = row.agentName;

  // Resolve or register the target agent. Mirrors the REST endpoint's
  // implicit-orchestrator-creation behavior.
  if (!(await registry.getAgent(agentName))) {
    await registry.registerAgent({ name: agentName, type: "orchestrator" });
  }
  const agentRow = (await registry.getAgent(agentName))!;
  const resumeSessionId = agentRow.sessionId ?? undefined;

  // Compose system prompt + skill detection + memory recall.
  const skillMatch = matchSkillInvocation(userText, agentRow.type);
  const promptText = skillMatch ? skillMatch.userText : userText;
  const {
    body: wrappedPrompt,
    systemPrompt: dispatchSystemPrompt,
    allowedToolsOverride,
  } = await buildDispatchPrompt(agentRow, {
    kind: "user_chat",
    userText: promptText,
    skillMatch: skillMatch ?? undefined,
  });

  // Decide queued-vs-immediate using the live-worker peek. Mirrors
  // the legacy REST path's `willQueue` decision.
  const liveBefore = peekLiveWorker(agentName);
  const willQueue = liveBefore?.status === "working";

  // Flip the row out of 'pending'. Also populate the session_id with
  // the agent's resumed session — the mutator wrote the sentinel
  // '__pending__' because the daemon owns the session boundary.
  await db
    .update(schema.blocks)
    .set({
      status: willQueue ? "queued" : "complete",
      sessionId: resumeSessionId ?? "__pending__",
    })
    .where(and(eq(schema.blocks.id, row.id), eq(schema.blocks.status, "pending")));

  // Dispatch the turn. The userBlockId is only passed when the prompt
  // will queue — that's the legacy contract: dispatchTurn uses it to
  // re-stamp the row's status when the worker drains the queue
  // (`block_meta_update` flips queued → streaming).
  const modelCfg = normalizeModelConfig(cfg.model);
  const turnCwd = await registry.workingDirectoryFor(agentRow);
  dispatchTurn({
    agentName,
    options: {
      agentName,
      agentType: agentRow.type,
      workingDirectory: turnCwd,
      systemPrompt: dispatchSystemPrompt,
      prompt: wrappedPrompt,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      turnId: row.turnId,
      model: modelCfg.name,
      thinking: modelCfg.thinking,
      effort: modelCfg.effort,
      resumeSessionId,
      daemonPort: resolveDaemonPort(cfg),
      parentName: "parentName" in agentRow ? (agentRow.parentName ?? undefined) : undefined,
      mode: agentRow.type === "scheduled" ? "one-shot" : "long-lived",
      allowedToolsOverride,
    },
    userBlockId: willQueue ? row.blockId : undefined,
  });

  // Attribute to the message's author (stamped on the block by the
  // sendUserMessage mutator); null → service actor for any non-user dispatch.
  captureFor(row.userId, "chat_turn_dispatched", {
    agent_name: agentName,
    agent_type: agentRow.type,
    turn_id: row.turnId,
    queued: willQueue,
    has_attachments: !!(attachments && attachments.length > 0),
    skill_invoked: skillMatch ? skillMatch.skill.name : null,
  });
  logger.log("info", "block.dispatch.applied", {
    block_id: row.blockId,
    agent: agentName,
    turn_id: row.turnId,
    queued: willQueue,
  });
}

export async function runDispatchBootScan(): Promise<void> {
  try {
    const db = getDb();
    const rows = await db
      .select({ id: schema.blocks.id })
      .from(schema.blocks)
      .where(and(eq(schema.blocks.status, "pending"), eq(schema.blocks.role, "user")));
    for (const row of rows) {
      await processPendingBlockRow(row.id);
    }
    logger.log("info", "block.dispatch-boot-scan.complete", {
      processed: rows.length,
    });
  } catch (err) {
    logger.log("warn", "block.dispatch-boot-scan.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface DispatchListenerHandle {
  stop: () => Promise<void>;
}

export async function startDispatchListener(): Promise<DispatchListenerHandle> {
  const pool = getPool();
  const connectionString =
    (pool.options as { connectionString?: string }).connectionString ??
    loadFridayConfig().databaseUrl;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set to start the sendUserMessage LISTEN connection.");
  }

  let stopped = false;
  let activeClient: InstanceType<typeof Client> | null = null;

  // FRI-121 B: reconnect loop with exponential backoff. keepAlive: true
  // causes the OS to send TCP keepalive probes so dead connections surface
  // via 'error' rather than hanging silently. Boot scan after each
  // (re)connect drains NOTIFYs missed during the downtime window.
  async function connectWithRetry(): Promise<void> {
    let delay = 1_000;
    while (!stopped) {
      try {
        const c = new Client({ connectionString, keepAlive: true });
        activeClient = c;
        await c.connect();
        c.on("notification", (msg) => {
          if (msg.channel !== LISTEN_CHANNELS.newPendingBlock) return;
          const id = msg.payload;
          if (!id) return;
          void processPendingBlockRow(id).catch((err) => {
            logger.log("warn", "block.dispatch-listen.process.error", {
              block_id: id,
              message: err instanceof Error ? err.message : String(err),
            });
          });
        });
        c.on("error", (err) => {
          logger.log("warn", "block.dispatch-listen.client.error", {
            message: err instanceof Error ? err.message : String(err),
          });
        });
        await c.query(`LISTEN ${LISTEN_CHANNELS.newPendingBlock}`);
        logger.log("info", "block.dispatch-listen.ready", {
          channel: LISTEN_CHANNELS.newPendingBlock,
        });
        await runDispatchBootScan();
        delay = 1_000;
        await new Promise<void>((resolve) => c.once("end", resolve));
      } catch (err) {
        logger.log("warn", "block.dispatch-listen.connect.error", {
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
          await activeClient.query(`UNLISTEN ${LISTEN_CHANNELS.newPendingBlock}`);
        } catch {
          // best-effort
        }
        await activeClient.end().catch(() => {});
      }
    },
  };
}

// Test-only export.
export { processPendingBlockRow as _processPendingBlockRow };
