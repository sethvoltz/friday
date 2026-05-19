import {
  closeDb,
  ensureDirs,
  ensureFridayEnv,
  ensureSoul,
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
import { reconcileAppsOnBoot } from "./apps/reconcile.js";
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
  runSettingsBootScan,
  startSettingsListener,
} from "./settings/listener.js";
import {
  runMemoryBootScan,
  startMemoryListener,
} from "./memory/listener.js";
import {
  runScheduleBootScan,
  startScheduleListener,
} from "./scheduler/listener.js";
import { runAppBootScan, startAppListener } from "./apps/listener.js";
import {
  runArchiveBootScan,
  startArchiveListener,
} from "./agent/archive-listener.js";
import {
  runCancelBootScan,
  startCancelListener,
} from "./agent/cancel-listener.js";
import {
  runAbortBootScan,
  startAbortListener,
} from "./agent/abort-listener.js";
import {
  runDispatchBootScan,
  startDispatchListener,
} from "./agent/dispatch-listener.js";
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
  await runMigrations();
  ensureSoul();

  const backfill = await backfillUsageFromLegacyJsonl();
  if ("skipped" in backfill && backfill.skipped) {
    logger.log("info", "usage.backfill.skip", { reason: backfill.reason });
  } else {
    logger.log("info", "usage.backfill.done", {
      inserted: backfill.inserted,
      source: backfill.source,
    });
  }

  // Phase 4.3: settings boot-recovery scan. Must run BEFORE the
  // first `loadConfig()` below — settings changes that landed while
  // the daemon was down need to be applied to ~/.friday/config.json
  // so the daemon sees the user's intent on the very first read.
  await runSettingsBootScan();

  const cfg = loadConfig();
  const server = startServer({ port: cfg.daemonPort });
  const heartbeat = startHealthHeartbeat();

  // Phase 4.3: open the long-lived LISTEN connection for
  // `friday_settings_changed`. Subsequent settings updates from the
  // dashboard mutator rewrite config.json without a daemon restart,
  // so the next worker spawn picks up the new value.
  const settingsListener = await startSettingsListener();

  // Phase 4.5: open the long-lived LISTEN connection for
  // `friday_memory_file_changed`. Boot-recovery scan first to apply
  // any pending rows that landed while the daemon was down.
  await runMemoryBootScan();
  const memoryListener = await startMemoryListener();

  // Phase 4.6: open the long-lived LISTEN connection for
  // `friday_schedule_changed`. Boot-recovery scan first to apply
  // pending registers/reloads/deletes that landed while the daemon
  // was down. Runs BEFORE the scheduler's 30s tick starts so a
  // dashboard-created schedule is registered before its first fire
  // window opens.
  await runScheduleBootScan();
  const scheduleListener = await startScheduleListener();

  // Phase 4.7: open the long-lived LISTEN connection for
  // `friday_app_changed`. Boot-recovery scan runs AFTER
  // `reconcileAppsOnBoot()` (already invoked earlier) — that one
  // handles disk-vs-DB drift; this one handles the narrower case
  // of dashboard-mutator-initiated pending requests that didn't
  // get processed before the daemon went down.
  await runAppBootScan();
  const appListener = await startAppListener();

  // Phase 4.8: open the long-lived LISTEN connection for
  // `friday_archive_requested`. Boot-recovery scan picks up
  // archive requests that landed during daemon downtime.
  await runArchiveBootScan();
  const archiveListener = await startArchiveListener();

  // Phase 4.9: open the long-lived LISTEN connection for
  // `friday_block_canceled`. Boot-recovery scan applies any
  // `status='cancel_requested'` rows that landed during daemon
  // downtime (the mutator commits durably even when the daemon is
  // down; the LISTEN handler picks them up on next boot). Must run
  // BEFORE `recoverQueuedTurns()` so a row marked `cancel_requested`
  // pre-shutdown is yanked from the queue before any worker re-spawn
  // could re-dispatch it.
  await runCancelBootScan();
  const cancelListener = await startCancelListener();

  // Phase 4.10: open the long-lived LISTEN connection for
  // `friday_abort_requested`. Boot-recovery scan applies any
  // `status='abort_requested'` rows that landed during daemon
  // downtime, calls the lifecycle abort (no-op if no live worker)
  // and flips the row back to 'complete'. Must run BEFORE
  // `recoverQueuedTurns()` so a turn marked aborted pre-shutdown
  // isn't accidentally re-dispatched on restart.
  await runAbortBootScan();
  const abortListener = await startAbortListener();

  // Phase 4.11b: open the long-lived LISTEN connection for
  // `friday_new_pending_block`. Boot-recovery scan dispatches any
  // user-chat blocks that landed at status='pending' while the
  // daemon was down (the mutator commits durably even when the
  // daemon is offline). Must run BEFORE `recoverQueuedTurns()` so
  // the dispatch path isn't doubled up.
  await runDispatchBootScan();
  const dispatchListener = await startDispatchListener();

  // Boot recovery
  startMailBridge(); // subscribe before replayPending so recovered mail fires through the bridge
  await replayPending();
  await seedMetaAgents();
  await reconcileAppsOnBoot();
  await recoverAgents(cfg);
  await recoverQueuedTurns(cfg);
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
        // Phase 5: `system_banner` SSE retired. The dashboard's
        // sidebar will pick up the orphan-count signal from the
        // `system_banners` table (ADR-024) in Phase 6; for now the
        // info-level surface is the daemon log entry below.
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
    void settingsListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
    void memoryListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
    void scheduleListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
    void appListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
    void archiveListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
    void cancelListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
    void abortListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
    void dispatchListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
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
async function recoverAgents(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const jsonlAgents: RecoveryAgent[] = [];
  for (const a of await registry.listAgents()) {
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
      await registry.archiveAgent(a.name);
      // Phase 5: `agent_lifecycle` SSE retired — Zero's `agents`
      // slice replicates the status transition reactively to the
      // dashboard sidebar.
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
      await registry.setStatus(a.name, "idle");
    }
    const cwd = await registry.workingDirectoryFor(a);
    if (a.sessionId) {
      jsonlAgents.push({
        agentName: a.name,
        sessionId: a.sessionId,
        workingDirectory: cwd,
      });
    }

    if (a.type !== "scheduled" && a.status !== "archived") {
      const pending = await mailInbox(a.name);
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
          const wrappedMailPrompt = await wrapWithRecall(intent, mailPrompt, "mail");
          dispatchTurn({
            agentName: a.name,
            options: {
              agentName: a.name,
              agentType: a.type,
              workingDirectory: cwd,
              systemPrompt,
              prompt: wrappedMailPrompt,
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
      await recoverFromJsonl(jsonlAgents);
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
async function recoverQueuedTurns(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const queued = await listQueuedUserBlocks();
  if (queued.length === 0) return;
  const modelCfg = normalizeModelConfig(cfg.model);
  for (const block of queued) {
    const a = await registry.getAgent(block.agentName);
    if (!a || a.status === "archived") {
      logger.log("info", "queued-turn.recovery.skip", {
        agent: block.agentName,
        turnId: block.turnId,
        reason: a ? "archived" : "agent_missing",
      });
      await deleteBlockById(block.blockId);
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
      await deleteBlockById(block.blockId);
      continue;
    }
    if (!text.trim() && !attachments) {
      await deleteBlockById(block.blockId);
      continue;
    }
    const stack = readPromptStack(a.type, []);
    const systemPrompt = composeSystemPrompt(stack, {
      agentName: a.name,
      agentType: a.type,
      parentName: "parentName" in a ? a.parentName ?? undefined : undefined,
    });
    const wrappedPrompt = await wrapWithRecall(text, text, "user_chat");
    const queuedCwd = await registry.workingDirectoryFor(a);
    try {
      dispatchTurn({
        agentName: a.name,
        options: {
          agentName: a.name,
          agentType: a.type,
          workingDirectory: queuedCwd,
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
 * Close the Postgres pool on shutdown. Postgres manages its own WAL —
 * no explicit checkpoint needed (Postgres autovacuum + bgwriter handle
 * it). This is fire-and-forget; the shutdown timer below caps wait time.
 */
function flushDb(): void {
  void closeDb().catch((err: unknown) => {
    logger.log("warn", "db.close.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  });
}

// Node 15+ defaults to terminating the process on an unhandled promise
// rejection. The daemon owns long-lived listeners and async worker IPC
// pipes that don't always propagate failures back through awaited
// boundaries — a stray rejection from a child callback or LISTEN handler
// would otherwise kill the daemon with no log at all (tmux session
// vanishes, last log line is whatever happened before the rejection).
//
// Log with the rejection's stack so the underlying bug is fixable, but
// don't exit: a single misbehaved subsystem shouldn't take the daemon
// down. `uncaughtException` is a different beast — the runtime state is
// unsafe to continue in, so log and exit 1.
process.on("unhandledRejection", (reason, promise) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.log("error", "daemon.unhandled-rejection", {
    message: err.message,
    stack: err.stack,
    promise: String(promise),
  });
});
process.on("uncaughtException", (err) => {
  logger.log("error", "daemon.uncaught-exception", {
    message: err.message,
    stack: err.stack,
  });
  process.exit(1);
});

main().catch((err: unknown) => {
  logger.log("error", "daemon.fatal", {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
