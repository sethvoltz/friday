import { listAgents, updateAgentStatus } from "../sessions/registry.js";
import { mailSend } from "../comms/mail.js";
import { log } from "../log.js";
import { getCrashInfo } from "../agent/crash-store.js";

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
  /** Whether a query() call is currently in flight (true from query-started until turn-complete) */
  queryInFlight: boolean;
}

// ── Health check config ────────────────────────────────────────────────────

export interface HealthCheckConfig {
  /**
   * How long with no chunk AND no active tool AND not waiting for mail
   * before an agent is declared stalled. Default: 30 seconds.
   */
  stallThresholdMs: number;
  /**
   * How long after spawn before stall detection activates.
   * Builders spend 60–120s in a silent planning phase (reading the epic,
   * calling Linear, creating tasks) before sending any IPC events — without
   * a grace period the 30s stall threshold fires false positives.
   * Default: 2 minutes.
   */
  startupGracePeriodMs?: number;
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
  startupGracePeriodMs: 2 * 60 * 1000, // 2 minutes
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
    startupGracePeriodMs: currentConfig.startupGracePeriodMs,
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
        const crashDiag = getCrashInfo(name);
        const issue: HealthIssue = {
          type: "crashed",
          agentName: name,
          agentType: entry.type,
          message:
            `Agent "${name}" (${entry.type}) has no running process but ` +
            `registry status is "${entry.status}".`,
          ...(crashDiag !== null && {
            exitCode: crashDiag.exitCode,
            stderrTail: crashDiag.stderrTail,
          }),
        };
        issues.push(issue);
        notifiedCrashed.add(name);
        updateAgentStatus(name, "idle");
        notifyOrchestrator(issue);

        log("warn", "agent_health_crashed", {
          agent: name,
          type: entry.type,
          exitCode: crashDiag?.exitCode ?? null,
          stderrTail: crashDiag?.stderrTail ?? "",
        });
      }
    } else if (loopRunning) {
      notifiedCrashed.delete(name);
    }

    // ── Stall detection ──────────────────────────────────────────────────
    if (entry.status === "active" && loopRunning) {
      const gracePeriodMs = config.startupGracePeriodMs ?? 2 * 60 * 1000;
      const createdAtMs = new Date(entry.createdAt).getTime();
      const lastTs = getLastActivity(name);
      const hasCompletedTurn = lastTs !== null;

      // Skip stall detection for 0-turn agents still within the startup grace period.
      // Builders in a silent planning/thinking phase produce no output but are working.
      if (!hasCompletedTurn && now - createdAtMs <= gracePeriodMs) {
        notifiedStalled.delete(name);
      } else {
        const stallState = config.getStallState?.(name) ?? null;

        let isStalled = false;
        let stalledSec = 0;
        let stallMessage = "";
        let logEvent = "agent_health_stalled";

        if (stallState) {
          // IPC-based: check chunk heartbeat + tool/mail-wait/query-in-flight flags
          isStalled =
            !stallState.toolCallActive &&
            !stallState.waitingForMail &&
            !stallState.queryInFlight &&
            now - stallState.lastChunkAt > config.stallThresholdMs;
          stalledSec = Math.round((now - stallState.lastChunkAt) / 1000);
          stallMessage = hasCompletedTurn
            ? `Agent "${name}" (${entry.type}) stalled: no stream progress for ` +
              `${stalledSec}s (no chunk, no active tool, not waiting for mail).`
            : `Agent "${name}" (${entry.type}) has not completed any turns since spawning ` +
              `${Math.round((now - createdAtMs) / 1000)}s ago.`;
        } else if (hasCompletedTurn) {
          // Legacy: use last-turn timestamp for agents with 1+ turns
          isStalled = now - lastTs! > config.stallThresholdMs;
          stalledSec = Math.round((now - lastTs!) / 1000);
          stallMessage = `Agent "${name}" (${entry.type}) stalled: no turn progress for ${stalledSec}s.`;
          logEvent = "agent_health_stalled_legacy";
        } else {
          // 0-turn agent past grace period — use spawn time as baseline
          isStalled = now - createdAtMs > gracePeriodMs;
          stalledSec = Math.round((now - createdAtMs) / 1000);
          stallMessage =
            `Agent "${name}" (${entry.type}) has not completed any turns since spawning ` +
            `${stalledSec}s ago.`;
          logEvent = "agent_health_stalled_no_turns";
        }

        if (isStalled) {
          if (!notifiedStalled.has(name)) {
            const issue: HealthIssue = {
              type: "stalled",
              agentName: name,
              agentType: entry.type,
              message: stallMessage,
            };
            issues.push(issue);
            notifiedStalled.add(name);
            notifyOrchestrator(issue);
            log("warn", logEvent, { agent: name, stalledSec });
          }
        } else {
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
  exitCode?: number | null;
  stderrTail?: string;
}

// ── Notification ───────────────────────────────────────────────────────────

function notifyOrchestrator(issue: HealthIssue): void {
  try {
    const diagLines: string[] = [];
    if (issue.exitCode !== undefined) {
      diagLines.push(`Exit code: ${issue.exitCode ?? "(none)"}`);
    }
    if (issue.stderrTail) {
      diagLines.push(`Last stderr:\n${issue.stderrTail}`);
    }
    const body = diagLines.length > 0
      ? `${issue.message}\n\n${diagLines.join("\n")}`
      : issue.message;

    mailSend({
      from: "health-monitor",
      to: "orchestrator",
      subject: `Agent health: ${issue.agentName} ${issue.type}`,
      body,
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
