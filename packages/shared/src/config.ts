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
export const DAEMON_LOG_PATH = join(LOGS_DIR, "daemon.jsonl");
export const SCHEDULES_DIR = join(DATA_DIR, "schedules");
export const STATE_DIR = join(DATA_DIR, "state");
export const APPS_DIR = join(DATA_DIR, "apps");

export function appsDir(): string {
  return APPS_DIR;
}

export function appDir(id: string): string {
  return join(APPS_DIR, id);
}

export type ServiceName = "daemon" | "dashboard" | "tunnel";
export const SERVICES: ServiceName[] = ["daemon", "dashboard", "tunnel"];

export function statePathFor(service: ServiceName): string {
  return join(STATE_DIR, `${service}.json`);
}

export function getLogPath(service: string): string {
  // cloudflared writes plain text, not JSONL — use .log so consumers
  // (and `tail`) don't get tripped up by mixed formats.
  const ext = service === "tunnel" ? "log" : "jsonl";
  return join(LOGS_DIR, `${service}.${ext}`);
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
  /**
   * Public URL the Cloudflare Tunnel exposes Friday on, e.g.
   * `https://friday.example.com`. Display-only — `cloudflared` learns the
   * route from the connector token. Set via `friday setup --cloudflare`.
   */
  publicUrl?: string;
  /** Linear integration settings. Read by `@friday/integrations-linear`. */
  linear?: LinearIntegrationConfig;
}

export interface LinearIntegrationConfig {
  /**
   * Team to file new Linear issues against. Accepts either:
   * - a team UUID (what Linear's `issueCreate` mutation wants), or
   * - a team key like `"FRI"` (resolved to a UUID via `findTeamByKey` at
   *   call time).
   *
   * Overridden by the `FRIDAY_LINEAR_TEAM` env var. When unset, the
   * createIssue path falls back to the first team returned by Linear with
   * a `logger.warn`.
   */
  team?: string;
}

export interface WatchdogConfig {
  /**
   * When true, the watchdog refork-recovers stalled long-lived workers
   * (kill + respawn with `resume: sessionId`) instead of only surfacing
   * `agent_status: stalled`. Default false — flag this on once you trust
   * the stall threshold isn't catching false positives.
   */
  refork?: boolean;
  /**
   * Per-agent-type stall thresholds in milliseconds (FIX_FORWARD 4.2).
   * Workers whose `lastHeartbeat` is older than the bucket value for their
   * type are marked `stalled`. Scheduled agents get a much longer
   * threshold because legitimate one-shot runs (large research jobs,
   * lengthy backfills) can run for tens of minutes between heartbeats.
   */
  thresholdsMs?: Partial<Record<AgentTypeName, number>>;
}

/** Default stall thresholds applied when WatchdogConfig.thresholdsMs is
 *  absent or partial. Matches the FIX_FORWARD 4.2 spec values. */
export const DEFAULT_WATCHDOG_THRESHOLDS_MS: Record<AgentTypeName, number> = {
  orchestrator: 90_000,
  helper: 90_000,
  builder: 90_000,
  bare: 90_000,
  scheduled: 3_600_000,
};

export function watchdogThresholdMs(
  cfg: WatchdogConfig | undefined,
  type: AgentTypeName,
): number {
  return (
    cfg?.thresholdsMs?.[type] ?? DEFAULT_WATCHDOG_THRESHOLDS_MS[type]
  );
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
  // FIX_FORWARD 4.3: refork on by default. Per-agent-type thresholds
  // (FIX_FORWARD 4.2) keep this from firing on legitimate long
  // scheduled runs. Users who want observe-only can set
  // `watchdog.refork: false` in ~/.friday/config.json.
  watchdog: { refork: true },
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
    APPS_DIR,
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
