import { getDb, closeDb } from "@friday/shared";
import { reconcileMemories } from "@friday/memory";
import { loadRuntimeConfig } from "./config.js";
import { migrateUsageLog } from "./monitor/usage.js";
import { startTranscriptIndexer, stopTranscriptIndexer } from "./monitor/transcript-indexer.js";
import { createSlackApp } from "./slack/app.js";
import { registerEventHandlers } from "./slack/events.js";
import { loadSessions } from "./sessions/manager.js";
import { loadRegistry } from "./sessions/registry.js";
import { initOrchestrator, restoreActiveAgents, isAgentRunning, getAgentStallState, killAllAgents } from "./agent/lifecycle.js";
import { log, closeLog } from "./log.js";
import { startHealthHeartbeat, stopHealthHeartbeat } from "./monitor/health.js";
import { startAgentHealthCheck, stopAgentHealthCheck } from "./monitor/agent-health.js";
import { startMailPoller, stopMailPoller } from "./comms/mail-poller.js";
import { startEventServer, stopEventServer } from "./events/server.js";
import { sendToAgent } from "./agent/client.js";
import { createSlackTools } from "./agent/tools.js";
import { createAgentTools } from "./agent/agent-tools.js";
import { createMailTools } from "./comms/mail-tools.js";
import { buildSystemPrompt, chunkMessage } from "./slack/helpers.js";
import { slackPreflight } from "./slack/preflight.js";
import { createMemoryTools } from "./memory/memory-tools.js";
import { buildMemoryContext } from "./memory/auto-recall.js";
import { startScheduler, stopScheduler } from "./scheduler/scheduler.js";
import { drainScheduledRuns } from "./scheduler/trigger.js";
import { createScheduleTools } from "./scheduler/schedule-tools.js";
import { seedScheduledMetaAgents } from "./evolve/seed.js";
import { createEvolveTools } from "./evolve/evolve-tools.js";

async function main() {
  const startTime = Date.now();

  log("info", "friday_starting", {});

  const config = loadRuntimeConfig();
  // Open the DB (runs pending Drizzle migrations) and import any legacy
  // usage.jsonl into the `usage` table on first boot.
  getDb();
  await migrateUsageLog();
  const memReconcile = reconcileMemories();
  log("info", "memory_reconciled", memReconcile);
  loadSessions();
  loadRegistry();
  initOrchestrator();
  log("info", "config_loaded", {
    orchestratorChannelId: config.slack.orchestratorChannelId,
    workingDirectory: config.agent.workingDirectory,
    model: config.agent.model,
    streamingEnabled: config.slack_formatting.streamingEnabled,
  });

  const app = createSlackApp(config);
  registerEventHandlers(app, config);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // Prevent double-shutdown
    shuttingDown = true;

    const uptimeMs = Date.now() - startTime;
    log("info", "shutdown_started", { signal, uptimeMs });

    stopHealthHeartbeat();
    stopAgentHealthCheck();
    stopMailPoller();
    stopScheduler();
    stopTranscriptIndexer();
    // Kill all forked agent worker processes before draining scheduled runs.
    await killAllAgents(5_000);
    // Wait for in-flight scheduled runs to abort cleanly before exiting.
    // Without this, SIGTERM mid-run leaves orphan SDK subprocesses and stale "active" status.
    try {
      await drainScheduledRuns(10_000);
    } catch (err) {
      log("error", "scheduler_drain_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await stopEventServer();
    try {
      await app.stop();
    } catch {
      // Ignore stop errors during shutdown
    }

    try {
      closeDb();
    } catch (err) {
      log("error", "db_close_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    log("info", "shutdown_complete", {});
    closeLog();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Catch unhandled rejections — log and exit
  process.on("unhandledRejection", (reason) => {
    log("error", "unhandled_rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
    process.exit(1);
  });

  await app.start();
  startHealthHeartbeat({ eventServerPort: config.eventServer.port });
  await startEventServer(config.eventServer.port);
  startTranscriptIndexer();

  const orchChannelId = config.slack.orchestratorChannelId;
  const maxLen = config.slack_formatting.maxMessageLength;

  // Resolve bot user ID for preflight (auth.test returns the bot's identity)
  const authResult = await app.client.auth.test();
  const botUserId = authResult.user_id ?? "";

  // Clean up dangling Slack state from previous crash/restart
  await slackPreflight({
    client: app.client,
    channelId: orchChannelId,
    emojis: config.slack_formatting.emojiReactions,
    botUserId,
  });

  // Mail poller: when agents mail the orchestrator, trigger a real orchestrator
  // turn via sendToAgent and post the response to Slack.

  startMailPoller({
    agentName: "orchestrator",
    onMail: async (prompt) => {
      try {
        const slackMcp = createSlackTools(app.client);
        const agentMcp = createAgentTools({
          callerName: "orchestrator",
          callerType: "orchestrator",
          workingDirectory: config.agent.workingDirectory,
          model: config.agent.model,
          postToSlack: async (text) => {
            await app.client.chat.postMessage({ channel: orchChannelId, text });
          },
          slackChannelId: orchChannelId,
        });
        const mailMcp = createMailTools({ callerName: "orchestrator" });

        // Auto-recall: inject relevant memories into the mail prompt
        const memoryContext = buildMemoryContext(prompt);
        const enrichedPrompt = memoryContext
          ? `${memoryContext}\n\n${prompt}`
          : prompt;

        const response = await sendToAgent(enrichedPrompt, {
          channelId: orchChannelId,
          sessionType: "orchestrator",
          workingDirectory: config.agent.workingDirectory,
          allowedTools: config.agent.allowedTools,
          model: config.agent.model,
          mcpServers: {
            "friday-slack": slackMcp,
            "friday-agents": agentMcp,
            "friday-mail": mailMcp,
            "friday-memory": createMemoryTools({ callerName: "orchestrator" }),
            "friday-scheduler": createScheduleTools({
              model: config.agent.model,
              defaultCwd: config.agent.workingDirectory,
            }),
            "friday-evolve": createEvolveTools({ callerName: "orchestrator" }),
          },
          systemPrompt: buildSystemPrompt(
            config,
            "orchestrator",
            orchChannelId,
            config.agent.workingDirectory
          ),
        });

        // Post the orchestrator's response to Slack (skip if no text output)
        if (response) {
          const chunks = chunkMessage(response, maxLen);
          for (const chunk of chunks) {
            await app.client.chat.postMessage({
              channel: orchChannelId,
              text: chunk,
            });
          }
        }
      } catch (err) {
        log("error", "mail_poller_turn_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  // Restore agents that were active before shutdown
  restoreActiveAgents(config.agent.model);

  // Idempotently seed the daily self-improvement analyst before the scheduler
  // starts checking — otherwise its nextRunAt won't be considered until the
  // following 30s tick.
  seedScheduledMetaAgents({ cwd: config.agent.workingDirectory });

  // Start the scheduler for cron/one-shot scheduled agents
  startScheduler({ model: config.agent.model });

  // Start agent health monitoring with IPC-based stall detection
  startAgentHealthCheck({ isAgentRunning, getStallState: getAgentStallState });

  log("info", "friday_ready", {
    pid: process.pid,
    startupMs: Date.now() - startTime,
  });
}

main().catch((err) => {
  log("fatal", "startup_error", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
