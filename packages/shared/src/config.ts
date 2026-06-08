import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DATA_DIR = process.env.FRIDAY_DATA_DIR ?? join(homedir(), ".friday");

export const CONFIG_PATH = join(DATA_DIR, "config.json");
/** Machine-local autogen secrets (gitignored). */
export const ENV_LOCAL_PATH = join(DATA_DIR, ".env.local");
/** Legacy plaintext env — migration source only. */
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
export const SPIKE_CURSOR_PATH = join(EVOLVE_DIR, "spike-cursor.json");
export const HEALTH_PATH = join(DATA_DIR, "health.json");
export const USAGE_LOG_PATH = join(DATA_DIR, "usage.jsonl");
export const DAEMON_LOG_PATH = join(LOGS_DIR, "daemon.jsonl");
export const SCHEDULES_DIR = join(DATA_DIR, "schedules");
export const STATE_DIR = join(DATA_DIR, "state");
export const APPS_DIR = join(DATA_DIR, "apps");
/** ~/.friday/agents/<name>/ — per-agent home for the orchestrator, every
 *  helper, and every scheduled agent. Pins their `cwd` so the Claude SDK's
 *  `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` lookup is stable
 *  across daemon-install changes (FRI-61). Builders unaffected — they
 *  keep their git-worktree cwd. */
export const AGENTS_DIR = join(DATA_DIR, "agents");

export function appsDir(): string {
  return APPS_DIR;
}

export function appDir(id: string): string {
  return join(APPS_DIR, id);
}

export type ServiceName = "daemon" | "dashboard" | "zero-cache" | "tunnel";
export const SERVICES: ServiceName[] = ["daemon", "dashboard", "zero-cache", "tunnel"];

/** ~/.friday/zero/ — zero-cache's internal replica + lock files. Not part
 *  of Friday's data; safe to delete (zero-cache will rebuild from
 *  Postgres logical replication on next start). */
export const ZERO_DIR = join(DATA_DIR, "zero");

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
  /**
   * Daemon HTTP port (localhost only). Optional — `~/.friday/config.json`
   * may omit it, in which case `resolveDaemonPort()` falls back to
   * `process.env.FRIDAY_DAEMON_PORT` (used by dev wrappers) and finally
   * to `PROD_DAEMON_PORT`.
   */
  daemonPort?: number;
  /**
   * Dashboard port. Optional — `~/.friday/config.json` may omit it, in
   * which case `resolveDashboardPort()` falls back to
   * `PROD_DASHBOARD_PORT`. `start.ts` resolves and passes the value as
   * `PORT=<resolved>` to the dashboard spawn (adapter-node's
   * convention). `vite dev` ignores this entirely and binds 5173 from
   * `vite.config.ts`.
   */
  dashboardPort?: number;
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
  /**
   * Per-role model overrides (FRI-16). Missing keys fall through to
   * `cfg.model` — resolution goes through `resolveModelForRole`, never a
   * direct read, so the fallback semantics live in one place.
   */
  models?: Partial<Record<AgentTypeName, string | ModelConfig>>;
  /** Evolve agency settings (FRI-40 triage helpers; FRI-149 auto-builders;
   *  FRI-16 per-task model overrides). */
  evolve?: {
    autoSpawnTriageHelpers?: boolean;
    autoSpawnBuilders?: boolean;
    /** Per-evolve-task model overrides (FRI-16). Missing keys fall through
     *  to `cfg.model` via `resolveModelForEvolveTask`. */
    models?: Partial<Record<EvolveTaskName, string | ModelConfig>>;
  };
  /** Context-budget compaction policy (FRI-156): per-agent-type auto-compact
   *  window + nightly maintenance-sweep tuning. */
  compaction?: CompactionConfig;
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
   * (kill + respawn with `resume: sessionId`) instead of only projecting
   * `agents.status="stalled"` via the Turn-state machine's `stall`
   * Transition (FRI-145). Default true (see `DEFAULT_CONFIG` below) — the
   * per-agent-type stall thresholds keep it from firing on legitimate long
   * scheduled runs; set `watchdog.refork: false` for observe-only.
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
  // FRI-16: planners are deep-research agents — multi-minute thinking
  // between heartbeats is legitimate, like a scheduled run. Matching the
  // scheduled-class threshold avoids spurious "stalled" markers.
  planner: 3_600_000,
};

export function watchdogThresholdMs(cfg: WatchdogConfig | undefined, type: AgentTypeName): number {
  return cfg?.thresholdsMs?.[type] ?? DEFAULT_WATCHDOG_THRESHOLDS_MS[type];
}

/**
 * Context-budget compaction policy (FRI-156). Two-number scheme: the nightly
 * `sweep*` knobs keep long-lived idle agents' next-wake context small (~100K),
 * while `autoCompactWindow` is the per-agent-type SDK ceiling that catches
 * runaway days. All fields optional; every read goes through a `?? DEFAULT`
 * resolver below (see `CONFIG SHALLOW-MERGE DROP` rationale — `loadConfig`
 * does a shallow `{...DEFAULT_CONFIG, ...parsed}`, so a user setting one field
 * would otherwise drop the sibling defaults).
 */
export interface CompactionConfig {
  /** Local-time hour (0–23) the nightly maintenance sweep runs. */
  sweepHour?: number;
  /** Local-time minute (0–59) the nightly maintenance sweep runs. */
  sweepMinute?: number;
  /** Estimated-context token floor above which an idle agent is swept. */
  sweepThresholdTokens?: number;
  /** Per-agent-type SDK auto-compact window (`settings.autoCompactWindow`). */
  autoCompactWindow?: Partial<Record<AgentTypeName, number>>;
}

/** Default per-agent-type SDK auto-compact window applied when
 *  `CompactionConfig.autoCompactWindow` is absent or partial. 200K for every
 *  type (FRI-156 §A) — the SDK ceiling backstop, distinct from the 100K sweep
 *  threshold. Defaults in code (never .env), overridable via config. */
export const DEFAULT_AUTO_COMPACT_WINDOW: Record<AgentTypeName, number> = {
  orchestrator: 200_000,
  helper: 200_000,
  builder: 200_000,
  scheduled: 200_000,
  bare: 200_000,
  planner: 200_000,
};

/** Default nightly maintenance-sweep schedule + threshold (FRI-156 §B):
 *  03:30 local, 100K-token floor. Defaults in code; config overrides per field. */
export const DEFAULT_COMPACTION_SWEEP = {
  sweepHour: 3,
  sweepMinute: 30,
  sweepThresholdTokens: 100_000,
} as const;

/** Floor a user-supplied token budget at a sane minimum so a hostile/buggy
 *  `~/.friday/config.json` value (e.g. `0` or `1`) can't drive a pathological
 *  constant-compaction loop or sweep-everything-every-night. A non-finite
 *  value falls back to the default. */
function clampTokenBudget(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(10_000, Math.floor(value));
}

/** Clamp an integer config value to `[min, max]`, falling back to the default
 *  on `undefined` / non-finite. */
function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function autoCompactWindowFor(cfg: FridayConfig, type: AgentTypeName): number {
  return clampTokenBudget(
    cfg.compaction?.autoCompactWindow?.[type],
    DEFAULT_AUTO_COMPACT_WINDOW[type],
  );
}

export function compactionSweepHour(cfg: FridayConfig): number {
  return clampInt(cfg.compaction?.sweepHour, 0, 23, DEFAULT_COMPACTION_SWEEP.sweepHour);
}

export function compactionSweepMinute(cfg: FridayConfig): number {
  return clampInt(cfg.compaction?.sweepMinute, 0, 59, DEFAULT_COMPACTION_SWEEP.sweepMinute);
}

export function compactionSweepThreshold(cfg: FridayConfig): number {
  return clampTokenBudget(
    cfg.compaction?.sweepThresholdTokens,
    DEFAULT_COMPACTION_SWEEP.sweepThresholdTokens,
  );
}

/**
 * Normalize the polymorphic `model` field to a flat ModelConfig with all
 * defaults filled in. Callers shouldn't have to care about the string-vs-
 * object form.
 */
export function normalizeModelConfig(model: string | ModelConfig | undefined): ModelConfig {
  if (typeof model === "string") {
    return { name: model };
  }
  if (!model) {
    return { name: "claude-opus-4-7" };
  }
  return { ...model };
}

/** Evolve pipeline LLM passes that can carry a per-task model override
 *  (FRI-16). Mirrors the three `chat()` callers in `packages/evolve/src/`. */
export type EvolveTaskName = "enrich" | "scanFriction" | "scanPreferences";

/**
 * Resolve the model for an agent role (FRI-16): `cfg.models[role]` when set,
 * else the global `cfg.model`. Every daemon spawn site routes through this so
 * a missing override always means "global default", never a hardcoded model.
 */
export function resolveModelForRole(cfg: FridayConfig, role: AgentTypeName): ModelConfig {
  const override = cfg.models?.[role];
  return normalizeModelConfig(override ?? cfg.model);
}

/**
 * Resolve the model for an evolve internal LLM pass (FRI-16):
 * `cfg.evolve.models[task]` when set, else the global `cfg.model`.
 */
export function resolveModelForEvolveTask(cfg: FridayConfig, task: EvolveTaskName): ModelConfig {
  const override = cfg.evolve?.models?.[task];
  return normalizeModelConfig(override ?? cfg.model);
}

// `coerceLegacyModelId` lives in model-ids.ts (browser-safe — no node:*
// imports) because the client-bundled `@friday/shared/sync` surface needs it
// too. Re-exported here so node-side consumers keep importing it alongside
// `normalizeModelConfig` / `loadConfig` from the root barrel.
export { coerceLegacyModelId } from "./model-ids.js";

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
  | "bare"
  | "planner";

/**
 * Production port assignments. The full resolution chain everywhere is
 *   `process.env.FRIDAY_<X>_PORT ?? cfg.<x>Port ?? PROD_<X>_PORT`
 * for the daemon (so the dev dashboard wrapper can override without
 * rebuilding) and
 *   `cfg.dashboardPort ?? PROD_DASHBOARD_PORT`
 * for the dashboard (start.ts passes the result as `PORT` to the
 * dashboard spawn). Dev keeps its existing ports — daemon 7444, vite
 * 5173 — via the wrappers in root package.json, not via these defaults.
 * Zero-cache stays at the Zero convention (4848); no constant here
 * because `server-entry.mjs` already reads `ZERO_CACHE_PORT` env.
 *
 * "TGIF" is the dashboard mnemonic — 7615.
 */
export const PROD_DAEMON_PORT = 7610;
export const PROD_DASHBOARD_PORT = 7615;

/**
 * Resolve the daemon's port from the standard chain:
 *   `process.env.FRIDAY_DAEMON_PORT ?? cfg.daemonPort ?? PROD_DAEMON_PORT`
 *
 * Used by:
 * - `services/daemon/src/index.ts` for its own `startServer` bind.
 * - `services/dashboard/src/lib/server/daemon.ts` for the upstream URL.
 *
 * Symmetric on both sides of the dev IPC: when the dev wrappers set
 * `FRIDAY_DAEMON_PORT=7444`, both the daemon (binding) and the
 * dashboard (fetching) resolve to 7444 without a rebuild or a config
 * edit. In prod the env is unset, so the chain falls through to the
 * config override (if set) or the prod constant.
 *
 * Invalid env values (non-numeric, NaN, ≤0) are ignored so a typo
 * doesn't silently mis-bind.
 */
export function resolveDaemonPort(cfg: FridayConfig): number {
  const envRaw = process.env.FRIDAY_DAEMON_PORT;
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return cfg.daemonPort ?? PROD_DAEMON_PORT;
}

/**
 * Resolve the dashboard's port from `cfg.dashboardPort ??
 * PROD_DASHBOARD_PORT`. No env override — adapter-node's `PORT` is the
 * dashboard process's own knob and is set by `start.ts` from this
 * chain, so the env var is downstream of the resolution, not part of
 * it.
 */
export function resolveDashboardPort(cfg: FridayConfig): number {
  return cfg.dashboardPort ?? PROD_DASHBOARD_PORT;
}

export const DEFAULT_CONFIG: FridayConfig = {
  model: "claude-opus-4-7",
  daemonPort: PROD_DAEMON_PORT,
  dashboardPort: PROD_DASHBOARD_PORT,
  sseKeepaliveSec: 20,
  workerMemoryBudgetMb: 2048,
  mcpServers: [],
  orchestratorName: "friday",
  // FIX_FORWARD 4.3: refork on by default. Per-agent-type thresholds
  // (FIX_FORWARD 4.2) keep this from firing on legitimate long
  // scheduled runs. Users who want observe-only can set
  // `watchdog.refork: false` in ~/.friday/config.json.
  watchdog: { refork: true },
  // FRI-40 / FRI-149: evolve agency is OFF by default. Opt in via
  // `evolve.autoSpawnTriageHelpers: true` (read-only triage helper on
  // promote-to-critical) and/or `evolve.autoSpawnBuilders: true`
  // (auto-spawn a Builder for a critical+code+high-severity proposal that
  // drives a green PR and stops at it — never auto-merges; the human merges)
  // in ~/.friday/config.json. Both flags live in the SAME `evolve` object
  // and are read with a strict `=== true` check so the shallow-merge
  // `{ evolve: {} }` case stays disabled.
  evolve: { autoSpawnTriageHelpers: false, autoSpawnBuilders: false },
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
    ZERO_DIR,
    STATE_DIR,
    AGENTS_DIR,
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
