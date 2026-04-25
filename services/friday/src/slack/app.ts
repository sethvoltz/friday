import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import type { RuntimeConfig } from "../config.js";
import { log } from "../log.js";

export function createSlackApp(config: RuntimeConfig): App {
  // Use a custom SocketModeReceiver with relaxed ping/pong timeouts.
  // Defaults (5s) fire false positives when the event loop is busy.
  // Note: clientPingTimeout also scales the reconnect backoff delay
  // (timeout * consecutiveFailures), so don't set it too high or
  // reconnection after display sleep becomes very slow.
  const receiver = new SocketModeReceiver({
    appToken: config.slackAppToken,
    logLevel: LogLevel.WARN,
    clientPingTimeout: 15_000,
    serverPingTimeout: 15_000,
  });

  // Log reconnection lifecycle for visibility
  const smClient = receiver.client;
  smClient.on("reconnecting" as any, () => {
    log("warn", "slack_reconnecting", {});
  });
  smClient.on("connected" as any, () => {
    log("info", "slack_connected", {});
  });
  smClient.on("disconnected" as any, () => {
    log("warn", "slack_disconnected", {});
  });

  const app = new App({
    token: config.slackBotToken,
    receiver,
    logLevel: LogLevel.WARN,
  });

  // Log global errors from Bolt
  app.error(async (error) => {
    log("error", "slack_app_error", {
      error: error.message ?? String(error),
    });
  });

  return app;
}
