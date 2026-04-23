import { loadRuntimeConfig } from "./config.js";
import { createSlackApp } from "./slack/app.js";
import { registerEventHandlers } from "./slack/events.js";
import { loadSessions } from "./sessions/manager.js";
import { loadRegistry } from "./sessions/registry.js";
import { log } from "./log.js";
import { startHealthHeartbeat, stopHealthHeartbeat } from "./monitor/health.js";

async function main() {
  const startTime = Date.now();

  log("info", "friday_starting", {});

  const config = loadRuntimeConfig();
  loadSessions();
  loadRegistry();
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
    try {
      await app.stop();
    } catch {
      // Ignore stop errors during shutdown
    }

    log("info", "shutdown_complete", {});
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
  startHealthHeartbeat();
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
