import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfig,
  CONFIG_PATH,
  FRIDAY_DIR,
  AGENTS_PATH,
  type AgentRegistry,
} from "@friday/shared";

const HEALTH_FILE = join(FRIDAY_DIR, "health.json");

interface HealthData {
  pid: number;
  startedAt: string;
  lastHeartbeat: string;
  uptimeMs: number;
}

export const load = async ({ url }) => {
  const config = loadConfig();
  const configExists = existsSync(CONFIG_PATH);

  // Health
  let health: HealthData | null = null;
  let daemonOnline = false;
  let eventServerPort = config.eventServer.port;

  if (existsSync(HEALTH_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(HEALTH_FILE, "utf-8"));
      health = raw;
      if (health) {
        const age = Date.now() - new Date(health.lastHeartbeat).getTime();
        daemonOnline = age < 60_000;
        if (raw.eventServerPort) {
          eventServerPort = raw.eventServerPort;
        }
      }
    } catch {
      // Malformed
    }
  }

  // Agent registry — read once at the root layout so child loads can pull it
  // via `await parent()` instead of re-reading agents.json on every navigation.
  let agents: AgentRegistry = {};
  if (existsSync(AGENTS_PATH)) {
    try {
      agents = JSON.parse(readFileSync(AGENTS_PATH, "utf-8"));
    } catch {
      // Malformed — leave empty.
    }
  }

  return {
    eventServerUrl: `http://${url.hostname}:${eventServerPort}/events`,
    health,
    daemonOnline,
    configExists,
    agents,
  };
};
