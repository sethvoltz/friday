import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FRIDAY_DIR, AGENTS_PATH, SESSIONS_DIR } from "@friday/shared";
import { readState } from "../state.js";
import { isRunning } from "../services.js";

/**
 * Wipe the orchestrator's session ID from agents.json and the channel
 * mapping from channels.json so the next daemon boot starts a fresh
 * orchestrator session. Useful when an orchestrator session is wedged
 * (corrupted history, model change, etc.) and you want a clean restart.
 *
 * Refuses to run while the daemon is alive — clearing session state
 * underneath a running daemon corrupts in-flight work.
 */
export function resetOrchestratorCommand(): void {
  const state = readState("daemon");
  if (state && isRunning(state.pid)) {
    console.error("Daemon is still running. Stop it first: friday stop daemon");
    process.exit(1);
  }

  let changed = false;

  if (existsSync(AGENTS_PATH)) {
    const registry = JSON.parse(readFileSync(AGENTS_PATH, "utf-8"));
    if (registry.orchestrator?.sessionId) {
      console.log(`  Clearing orchestrator session: ${registry.orchestrator.sessionId}`);
      registry.orchestrator.sessionId = null;
      writeFileSync(AGENTS_PATH, JSON.stringify(registry, null, 2));
      changed = true;
    }
  }

  const channelsFile = join(SESSIONS_DIR, "channels.json");
  if (existsSync(channelsFile)) {
    const channels: Record<string, string> = JSON.parse(readFileSync(channelsFile, "utf-8"));

    const configPath = join(FRIDAY_DIR, "config.json");
    let orchChannelId: string | null = null;
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      orchChannelId = config.slack?.orchestratorChannelId ?? null;
    }

    if (orchChannelId && channels[orchChannelId]) {
      console.log(`  Clearing channel session for ${orchChannelId}`);
      delete channels[orchChannelId];
      writeFileSync(channelsFile, JSON.stringify(channels, null, 2));
      changed = true;
    }
  }

  if (changed) {
    console.log("\n  Orchestrator session reset. Start the daemon to begin a fresh session.");
  } else {
    console.log("  No orchestrator session to reset.");
  }
}
