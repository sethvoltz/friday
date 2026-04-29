import { listAgents, updateAgentStatus } from "../sessions/registry.js";
import { mailSend } from "../comms/mail.js";
import { log } from "../log.js";

// ── Activity tracking ──────────────────────────────────────────────────────

/** Timestamp of the last turn completion per agent */
const lastActivity = new Map<string, number>();

export function recordActivity(agentName: string): void {
  lastActivity.set(agentName, Date.now());
}

export function clearActivity(agentName: string): void {
  lastActivity.delete(agentName);
}

export function getLastActivity(agentName: string): number | null {
  return lastActivity.get(agentName) ?? null;
}

// ── Stall state interface ─────────────────────────────────────────────────

/** IPC-derived stall state for an agent worker process */
export interface AgentStallState {
  /** Timestamp of last chunk-received heartbeat */
  lastChunkAt: number;
  /** Whether a tool call is currently active */
  toolCallActive: boolean;
  /** Whether the agent is idle, waiting for mail */
  waitingForMail: boolean;
}

// ── Health check config ────────────────────────────────────────────────────

export interface HealthCheckConfig {
  /**
   * How long with no chunk AND no active tool AND not waiting for mail
   * before an agent is declared stalled. Default: 30 seconds.
   */
  stallThresholdMs: number;
  /** How often to run the health check. Default: 60 seconds. */
  intervalMs: number;
  /** Returns true if an agent's worker process is running */
  isAgentRunning: (name: string) => boolean;
  /**
   * Returns the IPC-derived stall state for a running agent, or null if
   * no stall state is available (e.g., legacy agent not using fork).
   */
  getStallState?: (name: string) => AgentStallState | null;
}

const DEFAULT_CONFIG: HealthCheckConfig = {
  stallThresholdMs: 30_000,
  intervalMs: 60_000,
  isAgentRunning: () => false,
};

let checkInterval: ReturnType<typeof setInterval> | null = null;
let currentConfig: HealthCheckConfig = DEFAULT_CONFIG;

const notifiedStalled = new Set<string>();
const notifiedCrashed = new Set<string>();

// ── Start / Stop ───────────────────────────────────────────────────────────

export function startAgentHealthCheck(config?: Partial<HealthCheckConfig>): void {
  currentConfig = { ...DEFAULT_CONFIG, ...config };

  if (checkInterval) clearInterval(checkInterval);

  checkInterval = setInterval(() => {
    runHealthCheck(currentConfig);
  }, currentConfig.intervalMs);

  checkInterval.unref();

  log("info", "agent_health_check_started", {
    stallThresholdMs: currentConfig.stallThresholdMs,
    intervalMs: currentConfig.intervalMs,
  });
}

export function stopAgentHealthCheck(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

// ── Health check ───────────────────────────────────────────────────────────

/**
 * Run one health-check pass.
 *
 * Stall detection: all three must hold simultaneously —
 *   1. No chunk-received heartbeat in the last stallThresholdMs
 *   2. No tool call currently active
 *   3. Not in idle-wait-for-mail state
 *
 * Crash detection: process exited but registry still shows active/idle.
 */
export function runHealthCheck(config: HealthCheckConfig): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const now = Date.now();

  for (const { name, entry } of listAgents()) {
    if (entry.type === "orchestrator") continue;
    if (entry.type === "scheduled") continue;
    if (entry.status === "destroyed") continue;

    const loopRunning = config.isAgentRunning(name);

    // ── Crash detection ──────────────────────────────────────────────────
    if ((entry.status === "active" || entry.status === "idle") && !loopRunning) {
      if (!notifiedCrashed.has(name)) {
        const issue: HealthIssue = {
          type: "crashed",
          agentName: name,
          agentType: entry.type,
          message:
            `Agent "${name}" (${entry.type}) has no running process but ` +
            `registry status is "${entry.status}".`,
        };
        issues.push(issue);
        notifiedCrashed.add(name);
        updateAgentStatus(name, "idle");
        notifyOrchestrator(issue);
        log("warn", "agent_health_crashed", { agent: name, type: entry.type });
      }
    } else if (loopRunning) {
      notifiedCrashed.delete(name);
    }

    // ── Stall detection (3-condition IPC-based) ──────────────────────────
    if (entry.status === "active" && loopRunning && config.getStallState) {
      const stallState = config.getStallState(name);

      if (stallState) {
        const isStalled =
          !stallState.toolCallActive &&
          !stallState.waitingForMail &&
          now - stallState.lastChunkAt > config.stallThresholdMs;

        if (isStalled) {
          if (!notifiedStalled.has(name)) {
            const stalledSec = Math.round((now - stallState.lastChunkAt) / 1000);
            const issue: HealthIssue = {
              type: "stalled",
              agentName: name,
              agentType: entry.type,
              message:
                `Agent "${name}" (${entry.type}) stalled: no stream progress for ` +
                `${stalledSec}s (no chunk, no active tool, not waiting for mail).`,
            };
            issues.push(issue);
            notifiedStalled.add(name);
            notifyOrchestrator(issue);
            log("warn", "agent_health_stalled", { agent: name, stalledSec });
          }
        } else {
          notifiedStalled.delete(name);
        }
      } else {
        // No IPC stall state available — fall back to last-activity timestamp
        const lastTs = getLastActivity(name);
        if (lastTs && now - lastTs > config.stallThresholdMs) {
          if (!notifiedStalled.has(name)) {
            const stalledSec = Math.round((now - lastTs) / 1000);
            const issue: HealthIssue = {
              type: "stalled",
              agentName: name,
              agentType: entry.type,
              message:
                `Agent "${name}" (${entry.type}) stalled: no turn activity for ${stalledSec}s.`,
            };
            issues.push(issue);
            notifiedStalled.add(name);
            notifyOrchestrator(issue);
            log("warn", "agent_health_stalled_legacy", { agent: name, stalledSec });
          }
        } else if (lastTs) {
          notifiedStalled.delete(name);
        }
      }
    }
  }

  return issues;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface HealthIssue {
  type: "stalled" | "crashed";
  agentName: string;
  agentType: string;
  message: string;
}

// ── Notification ───────────────────────────────────────────────────────────

function notifyOrchestrator(issue: HealthIssue): void {
  try {
    mailSend({
      from: "health-monitor",
      to: "orchestrator",
      subject: `Agent health: ${issue.agentName} ${issue.type}`,
      body: issue.message,
    });
  } catch (err) {
    log("error", "agent_health_notify_failed", {
      agent: issue.agentName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function clearNotifications(agentName?: string): void {
  if (agentName) {
    notifiedStalled.delete(agentName);
    notifiedCrashed.delete(agentName);
  } else {
    notifiedStalled.clear();
    notifiedCrashed.clear();
  }
}
