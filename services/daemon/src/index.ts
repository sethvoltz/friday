import {
  closeDb,
  ensureDirs,
  ensureFridayEnv,
  ensureSoul,
  getRawDb,
  loadConfig,
  normalizeModelConfig,
  runMigrations,
} from "@friday/shared";
import { logger } from "./log.js";
import { startServer } from "./api/server.js";
import { startHealthHeartbeat, clearHealth } from "./monitor/health.js";
import { backfillUsageFromLegacyJsonl, replayPending } from "@friday/shared/services";
import { seedMetaAgents, startScheduler } from "./scheduler/scheduler.js";
import { reconcile as reconcileLinear } from "@friday/integrations-linear";
import { eventBus } from "./events/bus.js";
import * as registry from "./agent/registry.js";
import { recoverFromJsonl, type RecoveryAgent } from "./agent/jsonl-recovery.js";
import { startMailBridge } from "./comms/mail-bridge.js";
import { startWatchdog, stopWatchdog } from "./agent/watchdog.js";
import {
  dispatchTurn,
  reapAllLiveWorkers,
  startTurnStallWatchdog,
  stopTurnStallWatchdog,
} from "./agent/lifecycle.js";
import { sandboxExecAvailable } from "./agent/sandbox-profile.js";
import {
  startInvariantAuditor,
  stopInvariantAuditor,
} from "./agent/invariants.js";
import { wrapWithRecall } from "./agent/recall.js";
import { closeTicketForArchive } from "./services/ticket-close.js";
import {
  composeSystemPrompt,
  readPromptStack,
} from "@friday/shared";
import {
  deleteBlockById,
  inbox as mailInbox,
  listQueuedUserBlocks,
} from "@friday/shared/services";
import { buildMailPrompt } from "./comms/mail-prompt.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

async function main(): Promise<void> {
  ensureDirs();
  ensureFridayEnv();
  runMigrations();
  ensureSoul();

  const backfill = backfillUsageFromLegacyJsonl();
  if ("skipped" in backfill && backfill.skipped) {
    logger.log("info", "usage.backfill.skip", { reason: backfill.reason });
  } else {
    logger.log("info", "usage.backfill.done", {
      inserted: backfill.inserted,
      source: backfill.source,
    });
  }

  const cfg = loadConfig();
  const server = startServer({ port: cfg.daemonPort });
  const heartbeat = startHealthHeartbeat();

  // Boot recovery
  startMailBridge(); // subscribe before replayPending so recovered mail fires through the bridge
  replayPending();
  seedMetaAgents();
  recoverAgents(cfg);
  recoverQueuedTurns(cfg);
  const schedTick = startScheduler();
  const watchdog = startWatchdog();
  startTurnStallWatchdog();
  startInvariantAuditor();
  void reconcileLinear()
    .then((result) => {
      if (!result.ran) {
        logger.log("debug", "linear.reconcile.skip", { reason: result.reason });
        return;
      }
      if (result.orphans.length > 0) {
        const sample = result.orphans
          .slice(0, 3)
          .map((o) => o.identifier)
          .join(", ");
        eventBus.publish({
          v: 1,
          type: "system_banner",
          level: "info",
          text: `Linear: ${result.orphans.length} active ticket${
            result.orphans.length === 1 ? "" : "s"
          } not linked to Friday — first few: ${sample}`,
        });
        logger.log("info", "linear.reconcile.orphans", {
          count: result.orphans.length,
          stale: result.staleLinks.length,
          linked: result.linkedCount,
        });
      } else {
        logger.log("info", "linear.reconcile.clean", {
          linked: result.linkedCount,
          stale: result.staleLinks.length,
        });
      }
    })
    .catch((err) =>
      logger.log("warn", "linear.reconcile.error", {
        message: err instanceof Error ? err.message : String(err),
      }),
    );

  const modelCfg = normalizeModelConfig(cfg.model);
  logger.log("info", "daemon.ready", {
    port: cfg.daemonPort,
    model: modelCfg.name,
    thinking: modelCfg.thinking?.type ?? "default",
    effort: modelCfg.effort ?? "default",
  });

  // M2: Surface the kernel-sandbox status loudly at boot so an accidental
  // disable (FRIDAY_SANDBOX_EXEC=0) or a missing binary doesn't fail silent.
  const sb = sandboxExecAvailable();
  logger.log(sb.available ? "info" : "warn", "daemon.sandbox-exec", {
    enabled: sb.available,
    reason: sb.reason,
    note: sb.available
      ? "builders run under sandbox-exec; M2 kernel backstop active"
      : "builders NOT sandboxed; relying on M1 PreToolUse + M4 pgrp only",
  });

  const shutdown = (signal: string) => {
    logger.log("info", "daemon.shutdown", { signal });
    // M4: SIGTERM every live worker's process group before we exit so leaked
    // descendants don't get orphaned to launchd. Doesn't wait for the kill
    // to complete — the 2s ceiling below is the hard floor.
    reapAllLiveWorkers();
    clearInterval(heartbeat);
    clearInterval(schedTick);
    void watchdog;
    stopWatchdog();
    stopTurnStallWatchdog();
    stopInvariantAuditor();
    clearHealth();
    flushDb();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/**
 * Boot recovery for agents:
 *  - Heal orphaned builders: row says builder but the worktree directory
 *    is gone (e.g. the user archived it pre-F1-A, the buggy exit handler
 *    reset status to idle, and the workspace was already cleaned up).
 *    Archive them here so they don't get re-dispatched on every boot.
 *  - Reset any `working` status left by a daemon that died mid-turn (no
 *    worker is alive to drive the turn forward).
 *  - Reconcile each agent's JSONL against the blocks table once (FIX_FORWARD
 *    1.3). No live tail-watcher; live writes flow through worker IPC.
 *  - For long-lived agents (orchestrator/builder/helper/bare) with non-empty
 *    inboxes, dispatch a fresh turn so the pending mail isn't stranded.
 */
function recoverAgents(cfg: ReturnType<typeof loadConfig>): void {
  const jsonlAgents: RecoveryAgent[] = [];
  for (const a of registry.listAgents()) {
    // Heal-on-boot: a builder whose worktree was already removed cannot
    // run another turn. If we don't archive it here, the eligibility
    // check below would happily re-dispatch (sending it into the
    // missing-worktree void) every boot, and the dashboard would see a
    // ghost "working" agent forever. The migration to "archived" only
    // catches rows whose status was literally "killed" — agents that
    // were raced into "idle" by the pre-F1-A exit handler slip through
    // and land here.
    if (
      a.type === "builder" &&
      a.status !== "archived" &&
      "worktreePath" in a &&
      a.worktreePath &&
      !existsSync(a.worktreePath)
    ) {
      logger.log("info", "agent.recovery.archive-orphan", {
        agent: a.name,
        worktreePath: a.worktreePath,
      });
      // Capture ticketId before archive — the closer fires after the
      // registry row is flipped but reads from this captured value.
      const ticketId = a.ticketId ?? null;
      registry.archiveAgent(a.name);
      eventBus.publish({
        v: 1,
        type: "agent_lifecycle",
        agent: a.name,
        agentType: a.type,
        event: "archive",
        reason: "orphan-worktree",
      });
      // Newly-discovered orphan whose worktree is gone — work definitely
      // did not complete. Mark the linked ticket abandoned. Not a backfill
      // sweep of pre-existing in_progress rows; only orphans we observe
      // at boot get this treatment.
      void closeTicketForArchive({
        ticketId,
        reason: "abandoned",
        agentName: a.name,
      });
      continue;
    }
    if (a.status === "working") {
      logger.log("info", "agent.recovery.reset-working", { agent: a.name });
      registry.setStatus(a.name, "idle");
    }
    const cwd = registry.workingDirectoryFor(a);
    if (a.sessionId) {
      jsonlAgents.push({
        agentName: a.name,
        sessionId: a.sessionId,
        workingDirectory: cwd,
      });
    }

    if (a.type !== "scheduled" && a.status !== "archived") {
      const pending = mailInbox(a.name);
      if (pending.length > 0) {
        const stack = readPromptStack(a.type, []);
        const systemPrompt = composeSystemPrompt(stack, {
          agentName: a.name,
          agentType: a.type,
          parentName:
            "parentName" in a ? a.parentName ?? undefined : undefined,
        });
        const modelCfg = normalizeModelConfig(cfg.model);
        const turnId = `t_${randomUUID()}`;
        logger.log("info", "agent.recovery.drain-mail", {
          agent: a.name,
          pending: pending.length,
        });
        try {
          // FIX_FORWARD 2.5: wrap with recall on the joined mail bodies.
          const intent = pending.map((m) => m.body).join("\n\n");
          const mailPrompt = buildMailPrompt(a.name, pending);
          dispatchTurn({
            agentName: a.name,
            options: {
              agentName: a.name,
              agentType: a.type,
              workingDirectory: cwd,
              systemPrompt,
              prompt: wrapWithRecall(intent, mailPrompt, "mail"),
              turnId,
              model: modelCfg.name,
              thinking: modelCfg.thinking,
              effort: modelCfg.effort,
              resumeSessionId: a.sessionId ?? undefined,
              daemonPort: cfg.daemonPort,
              parentName:
                "parentName" in a ? a.parentName ?? undefined : undefined,
              mode: "long-lived",
            },
          });
        } catch (err) {
          logger.log("warn", "agent.recovery.dispatch-error", {
            agent: a.name,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  if (jsonlAgents.length > 0) {
    try {
      recoverFromJsonl(jsonlAgents);
    } catch (err) {
      logger.log("warn", "agent.recovery.jsonl-error", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Rehydrate user blocks left at `status='queued'` by a previous daemon
 * lifetime (the dashboard's send queue persisted them; the worker never
 * got to dispatch them before the process died). Each block dispatches
 * via `dispatchTurn` with its original turn_id and the row's blockId —
 * the first one for an agent spawns the worker, subsequent ones for the
 * same agent land in `nextPrompts` FIFO. On dispatch the row flips to
 * `complete` with a fresh `ts` via `block_meta_update`, so the dashboard
 * unpins each queued bubble as it runs.
 *
 * Archived agents are skipped and their queued rows deleted — there's no
 * worker to send the prompt to, and leaving them in the table would
 * surface as ghost pinned bubbles on the dashboard forever.
 */
function recoverQueuedTurns(cfg: ReturnType<typeof loadConfig>): void {
  const queued = listQueuedUserBlocks();
  if (queued.length === 0) return;
  const modelCfg = normalizeModelConfig(cfg.model);
  for (const block of queued) {
    const a = registry.getAgent(block.agentName);
    if (!a || a.status === "archived") {
      logger.log("info", "queued-turn.recovery.skip", {
        agent: block.agentName,
        turnId: block.turnId,
        reason: a ? "archived" : "agent_missing",
      });
      deleteBlockById(block.blockId);
      continue;
    }
    let text = "";
    let attachments:
      | Array<{ sha256: string; filename: string; mime: string }>
      | undefined;
    try {
      const parsed = JSON.parse(block.contentJson) as {
        text?: unknown;
        attachments?: Array<{ sha256: string; filename: string; mime: string }>;
      };
      if (typeof parsed.text === "string") text = parsed.text;
      if (Array.isArray(parsed.attachments) && parsed.attachments.length > 0) {
        attachments = parsed.attachments;
      }
    } catch {
      logger.log("warn", "queued-turn.recovery.parse-error", {
        agent: block.agentName,
        turnId: block.turnId,
      });
      deleteBlockById(block.blockId);
      continue;
    }
    if (!text.trim() && !attachments) {
      deleteBlockById(block.blockId);
      continue;
    }
    const stack = readPromptStack(a.type, []);
    const systemPrompt = composeSystemPrompt(stack, {
      agentName: a.name,
      agentType: a.type,
      parentName: "parentName" in a ? a.parentName ?? undefined : undefined,
    });
    const wrappedPrompt = wrapWithRecall(text, text, "user_chat");
    try {
      dispatchTurn({
        agentName: a.name,
        options: {
          agentName: a.name,
          agentType: a.type,
          workingDirectory: registry.workingDirectoryFor(a),
          systemPrompt,
          prompt: wrappedPrompt,
          attachments,
          turnId: block.turnId,
          model: modelCfg.name,
          thinking: modelCfg.thinking,
          effort: modelCfg.effort,
          resumeSessionId: a.sessionId ?? undefined,
          daemonPort: cfg.daemonPort,
          parentName: "parentName" in a ? a.parentName ?? undefined : undefined,
          mode: a.type === "scheduled" ? "one-shot" : "long-lived",
        },
        userBlockId: block.blockId,
      });
      logger.log("info", "queued-turn.recovery.dispatch", {
        agent: a.name,
        turnId: block.turnId,
      });
    } catch (err) {
      logger.log("warn", "queued-turn.recovery.error", {
        agent: a.name,
        turnId: block.turnId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Run a WAL checkpoint (TRUNCATE) and close the DB handle on shutdown.
 * Without this the WAL file grows unbounded across restarts and the main
 * `.sqlite` file stays cold. Data is durable either way (NORMAL sync), but
 * this keeps the on-disk shape sane and reads fast after restart.
 */
function flushDb(): void {
  try {
    getRawDb().pragma("wal_checkpoint(TRUNCATE)");
  } catch (err) {
    logger.log("warn", "db.checkpoint.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    closeDb();
  } catch (err) {
    logger.log("warn", "db.close.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

main().catch((err: unknown) => {
  logger.log("error", "daemon.fatal", {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
