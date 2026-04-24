import { listAgents, getAgent, updateAgentStatus } from "../sessions/registry.js";
import { mailSend } from "../comms/mail.js";
import { log } from "../log.js";

// ── Activity tracking ──────────────────────────────────────────

/** Timestamp of the last turn completion per agent */
const lastActivity = new Map<string, number>();

/**
 * Record that an agent just completed a turn.
 * Called from the agent loop after each successful query() result.
 */
export function recordActivity(agentName: string): void {
  lastActivity.set(agentName, Date.now());
}

/**
 * Remove activity tracking for a destroyed agent.
 */
export function clearActivity(agentName: string): void {
  lastActivity.delete(agentName);
}

/**
 * Get the last activity timestamp for an agent, or null if never recorded.
 */
export function getLastActivity(agentName: string): number | null {
  return lastActivity.get(agentName) ?? null;
}

// ── Health check ───────────────────────────────────────────────

export interface HealthCheckConfig {
  /** How long an "active" agent can go without a turn before it's stalled (ms) */
  stallThresholdMs: number;
  /** How often to run the health check (ms) */
  intervalMs: number;
  /** Function to check if an agent's loop is actually running */
  isAgentRunning: (name: string) => boolean;
}

const DEFAULT_CONFIG: HealthCheckConfig = {
  stallThresholdMs: 10 * 60 * 1000, // 10 minutes
  intervalMs: 60 * 1000, // check every 60 seconds
  isAgentRunning: () => false,
};

let checkInterval: ReturnType<typeof setInterval> | null = null;
let currentConfig: HealthCheckConfig = DEFAULT_CONFIG;

/** Agents we've already notified about — don't spam the orchestrator */
const notifiedStalled = new Set<string>();
const notifiedCrashed = new Set<string>();

/**
 * Start periodic agent health checks.
 */
export function startAgentHealthCheck(config?: Partial<HealthCheckConfig>): void {
  currentConfig = { ...DEFAULT_CONFIG, ...config };

  if (checkInterval) {
    clearInterval(checkInterval);
  }

  checkInterval = setInterval(() => {
    runHealthCheck(currentConfig);
  }, currentConfig.intervalMs);

  checkInterval.unref();

  log("info", "agent_health_check_started", {
    stallThresholdMs: currentConfig.stallThresholdMs,
    intervalMs: currentConfig.intervalMs,
  });
}

/**
 * Stop the health check loop.
 */
export function stopAgentHealthCheck(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

/**
 * Run a single health check pass. Exported for testing.
 */
export function runHealthCheck(config: HealthCheckConfig): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const now = Date.now();

  // Check all non-orchestrator, non-destroyed agents
  const agents = listAgents();

  for (const { name, entry } of agents) {
    if (entry.type === "orchestrator") continue;
    if (entry.status === "destroyed") continue;

    const loopRunning = config.isAgentRunning(name);

    // Crash detection: agent is active/idle in registry but loop is not running
    if ((entry.status === "active" || entry.status === "idle") && !loopRunning) {
      if (!notifiedCrashed.has(name)) {
        const issue: HealthIssue = {
          type: "crashed",
          agentName: name,
          agentType: entry.type,
          message: `Agent "${name}" (${entry.type}) has no running loop but status is "${entry.status}". It may have crashed.`,
        };
        issues.push(issue);
        notifiedCrashed.add(name);

        // Update status
        updateAgentStatus(name, "idle");

        // Notify orchestrator
        notifyOrchestrator(issue);

        log("warn", "agent_health_crashed", { agent: name, type: entry.type });
      }
    } else if (loopRunning) {
      // If loop is running, clear crash notification
      notifiedCrashed.delete(name);
    }

    // Stall detection: agent is "active" and loop is running,
    // but no turn has completed in stallThresholdMs
    if (entry.status === "active" && loopRunning) {
      const lastTs = lastActivity.get(name);
      if (lastTs && now - lastTs > config.stallThresholdMs) {
        if (!notifiedStalled.has(name)) {
          const stalledMinutes = Math.round((now - lastTs) / 60_000);
          const issue: HealthIssue = {
            type: "stalled",
            agentName: name,
            agentType: entry.type,
            message: `Agent "${name}" (${entry.type}) has been active with no turn progress for ${stalledMinutes} minutes.`,
          };
          issues.push(issue);
          notifiedStalled.add(name);

          notifyOrchestrator(issue);

          log("warn", "agent_health_stalled", {
            agent: name,
            type: entry.type,
            stalledMinutes,
          });
        }
      } else {
        // If activity resumed, clear stall notification
        notifiedStalled.delete(name);
      }
    }
  }

  return issues;
}

// ── Types ──────────────────────────────────────────────────────

export interface HealthIssue {
  type: "stalled" | "crashed";
  agentName: string;
  agentType: string;
  message: string;
}

// ── Notification ───────────────────────────────────────────────

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

/**
 * Reset notification state — for testing or when an agent is restarted.
 */
export function clearNotifications(agentName?: string): void {
  if (agentName) {
    notifiedStalled.delete(agentName);
    notifiedCrashed.delete(agentName);
  } else {
    notifiedStalled.clear();
    notifiedCrashed.clear();
  }
}
