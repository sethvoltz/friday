import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DATA_DIR =
  process.env.FRIDAY_DATA_DIR ?? join(homedir(), ".friday");

export const DB_PATH = join(DATA_DIR, "db.sqlite");
export const CONFIG_PATH = join(DATA_DIR, "config.json");
export const ENV_PATH = join(DATA_DIR, ".env");
export const SOUL_PATH = join(DATA_DIR, "SOUL.md");
export const SKILLS_DIR = join(DATA_DIR, "skills");
export const UPLOADS_DIR = join(DATA_DIR, "uploads");
export const LOGS_DIR = join(DATA_DIR, "logs");
export const MEMORY_DIR = join(DATA_DIR, "memory");
export const MEMORY_ENTRIES_DIR = join(MEMORY_DIR, "entries");
export const EVOLVE_DIR = join(DATA_DIR, "evolve");
export const EVOLVE_PROPOSALS_DIR = join(EVOLVE_DIR, "proposals");
export const EVOLVE_CLUSTERS_DIR = join(EVOLVE_DIR, "clusters");
export const FEEDBACK_LOG_PATH = join(EVOLVE_DIR, "feedback.jsonl");
export const RUNS_LOG_PATH = join(EVOLVE_DIR, "runs.jsonl");
export const HEALTH_PATH = join(DATA_DIR, "health.json");
export const USAGE_LOG_PATH = join(DATA_DIR, "usage.jsonl");
export const STATE_DIR = join(DATA_DIR, "state");

export type ServiceName = "daemon" | "dashboard";
export const SERVICES: ServiceName[] = ["daemon", "dashboard"];

export function statePathFor(service: ServiceName): string {
  return join(STATE_DIR, `${service}.json`);
}

export function getLogPath(service: string): string {
  return join(LOGS_DIR, `${service}.jsonl`);
}

export type ThinkingEffort = "low" | "medium" | "high";

export type ThinkingConfig =
  | { type: "adaptive" }
  | { type: "enabled"; budgetTokens?: number }
  | { type: "disabled" };

export interface ModelConfig {
  /** Model name, e.g. `"claude-opus-4-7"`. */
  name: string;
  /** Extended-thinking control. Default behavior matches the SDK's adaptive mode. */
  thinking?: ThinkingConfig;
  /** Effort level. Defaults to high (SDK default). */
  effort?: ThinkingEffort;
}

export interface FridayConfig {
  /**
   * Model the orchestrator runs on. Either:
   * - a string (just the model name; defaults are applied)
   * - an object with `name` plus optional `thinking` and `effort`
   */
  model: string | ModelConfig;
  /** Daemon HTTP port (localhost only). */
  daemonPort: number;
  /** Dashboard port. */
  dashboardPort: number;
  /** SSE keepalive interval in seconds. */
  sseKeepaliveSec: number;
  /** Aggregate worker memory budget in MB; surfaces a banner over this. */
  workerMemoryBudgetMb: number;
  /** User-configured MCP servers. */
  mcpServers: McpServerConfig[];
  /** Custom orchestrator name. Defaults to "friday". */
  orchestratorName: string;
  /** Worker stall watchdog tuning. */
  watchdog?: WatchdogConfig;
}

export interface WatchdogConfig {
  /**
   * When true, the watchdog refork-recovers stalled long-lived workers
   * (kill + respawn with `resume: sessionId`) instead of only surfacing
   * `agent_status: stalled`. Default false — flag this on once you trust
   * the stall threshold isn't catching false positives.
   */
  refork?: boolean;
}

/**
 * Normalize the polymorphic `model` field to a flat ModelConfig with all
 * defaults filled in. Callers shouldn't have to care about the string-vs-
 * object form.
 */
export function normalizeModelConfig(
  model: string | ModelConfig | undefined,
): ModelConfig {
  if (typeof model === "string") {
    return { name: model };
  }
  if (!model) {
    return { name: "claude-opus-4-7" };
  }
  return { ...model };
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Agent types that can use this MCP server. Empty/missing = all. */
  scope?: AgentTypeName[];
}

export type AgentTypeName =
  | "orchestrator"
  | "builder"
  | "helper"
  | "scheduled"
  | "bare";

export const DEFAULT_CONFIG: FridayConfig = {
  model: "claude-opus-4-7",
  daemonPort: 7444,
  dashboardPort: 5173,
  sseKeepaliveSec: 20,
  workerMemoryBudgetMb: 2048,
  mcpServers: [],
  orchestratorName: "friday",
  watchdog: { refork: false },
};

export function ensureDirs(): void {
  for (const dir of [
    DATA_DIR,
    SKILLS_DIR,
    UPLOADS_DIR,
    LOGS_DIR,
    MEMORY_DIR,
    MEMORY_ENTRIES_DIR,
    EVOLVE_DIR,
    EVOLVE_PROPOSALS_DIR,
    EVOLVE_CLUSTERS_DIR,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig(): FridayConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  const raw = readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as Partial<FridayConfig>;
  return { ...DEFAULT_CONFIG, ...parsed };
}

export function writeConfig(config: FridayConfig): void {
  if (!existsSync(dirname(CONFIG_PATH))) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}
