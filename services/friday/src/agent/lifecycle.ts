import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentType } from "@friday/shared";
import { setCrashInfo, clearCrashInfo } from "./crash-store.js";
export { getCrashInfo } from "./crash-store.js";
import {
  registerBuilder,
  registerHelper,
  registerOrchestrator,
  updateAgentSession,
  updateAgentStatus,
  destroyAgent as registryDestroy,
  getAgent,
  listAgents,
} from "../sessions/registry.js";
import {
  createWorkspace,
  destroyWorkspace,
  type RepoSource,
} from "./workspace.js";
import { buildAgentSystemPrompt, buildFirstTurnPrompt } from "./prime.js";
import { mailEvents } from "../comms/mail.js";
import { logUsage } from "../monitor/usage.js";
import { log } from "../log.js";
import { recordActivity, clearActivity } from "../monitor/agent-health.js";
import { recordTurnFiles, clearFileTracking } from "../monitor/file-tracker.js";
import { eventBus } from "../events/bus.js";
import type { WorkerCommand, WorkerEvent, WorkerSpawnOptions } from "./worker-protocol.js";

// ── Worker path ────────────────────────────────────────────────────────────

const _lifecycleDir = dirname(fileURLToPath(import.meta.url));
// tsx resolves .js imports to .ts source files in dev mode; fork() needs the
// actual path. Detect dev vs. compiled by checking the current file's extension.
const _isTsSource = import.meta.url.endsWith(".ts");
const WORKER_PATH = join(_lifecycleDir, _isTsSource ? "worker.ts" : "worker.js");

// ── Running agent state ───────────────────────────────────────────────────

interface StallState {
  /** Timestamp of last chunk-received heartbeat from this worker */
  lastChunkAt: number;
  /** Whether a tool call is currently active (tool-start without matching tool-end) */
  toolCallActive: boolean;
  /** Whether the worker is idle, waiting for mail (not a stall candidate) */
  waitingForMail: boolean;
  /** Whether a query() call is in flight (true from query-started until turn-complete) */
  queryInFlight: boolean;
}

interface RunningAgent {
  process: ChildProcess;
  sessionId: string | null;
  /** Stored so the agent can be re-forked with identical config after a kill */
  spawnOptions: WorkerSpawnOptions;
  stall: StallState;
  /** Cleanup thunk to unsubscribe the mailEvents listener for this agent */
  removeMailListener: () => void;
}

/** Tracks running agent processes by agent name */
const runningAgents = new Map<string, RunningAgent>();

// ── Public types ──────────────────────────────────────────────────────────


export interface CreateBuilderOptions {
  name: string;
  workingDirectory: string;
  repos: RepoSource[];
  epicId: string | null;
  /** Linear ticket identifier (e.g., "FRI-17") if this builder is bound to one. */
  linearTicket?: string | null;
  model: string;
  allowedTools?: string[];
}

export interface CreateHelperOptions {
  name: string;
  parent: string;
  taskId: string | null;
  cwd: string;
  model: string;
  allowedTools?: string[];
}

// ── Orchestrator init ─────────────────────────────────────────────────────

/**
 * Initialize the Orchestrator in the registry.
 * Called once at daemon startup. Does not spawn a loop —
 * the Orchestrator's session is managed by the Slack event handler.
 */
export function initOrchestrator(): void {
  registerOrchestrator();
}

// ── Builder / Helper creation ─────────────────────────────────────────────

export async function createBuilder(
  options: CreateBuilderOptions
): Promise<{ workspace: string }> {
  const {
    name,
    workingDirectory,
    repos,
    epicId,
    linearTicket = null,
    model,
    allowedTools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"],
  } = options;

  const workspaceInfo = createWorkspace({ builderName: name, workingDirectory, repos });
  registerBuilder(name, "orchestrator", workspaceInfo.path, epicId, linearTicket);

  const spawnOptions: WorkerSpawnOptions = {
    agentName: name,
    agentType: "builder",
    cwd: workspaceInfo.path,
    workingDirectory,
    model,
    allowedTools,
    epicId,
    parent: "orchestrator",
    workspace: workspaceInfo.path,
  };

  forkAgentProcess(spawnOptions);

  log("info", "builder_created", {
    name,
    workspace: workspaceInfo.path,
    epicId,
    worktreeCount: workspaceInfo.worktrees.length,
  });

  return { workspace: workspaceInfo.path };
}

export async function createHelper(options: CreateHelperOptions): Promise<void> {
  const {
    name,
    parent,
    taskId,
    cwd,
    model,
    allowedTools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"],
  } = options;

  registerHelper(name, parent, taskId, cwd);

  const parentEntry = getAgent(parent);
  const workingDirectory =
    parentEntry && "workspace" in parentEntry
      ? parentEntry.workspace
      : cwd;

  const spawnOptions: WorkerSpawnOptions = {
    agentName: name,
    agentType: "helper",
    cwd,
    workingDirectory,
    model,
    allowedTools,
    taskId,
    parent,
  };

  forkAgentProcess(spawnOptions);

  log("info", "helper_created", { name, parent, taskId, cwd });
}

// ── Destroy / Kill ────────────────────────────────────────────────────────

/**
 * Destroy an agent: stop its process gracefully (SIGTERM → 5s → SIGKILL),
 * clear tracking, and update the registry.
 */
export function destroyAgentByName(name: string): void {
  const entry = getAgent(name);
  if (!entry) throw new Error(`Agent "${name}" not found`);

  stopAgentProcess(name, false);
  clearActivity(name);
  clearCrashInfo(name);
  clearFileTracking(name);

  if (entry.type === "builder" && entry.workspace) {
    log("info", "workspace_preserved", { name, workspace: entry.workspace });
  }

  registryDestroy(name);
  log("info", "agent_destroyed_lifecycle", { name, type: entry.type });
}

/**
 * Kill an agent immediately with SIGKILL.
 * Unlike destroyAgentByName, this does NOT remove the workspace or registry
 * entry — the agent stays in registry with status "idle" and can be re-forked.
 */
export function killAgentByName(name: string): void {
  const entry = getAgent(name);
  if (!entry) throw new Error(`Agent "${name}" not found`);
  if (name === "orchestrator") throw new Error("Cannot kill the Orchestrator");

  const running = runningAgents.get(name);
  if (running) {
    running.removeMailListener();
    running.process.kill("SIGKILL");
    runningAgents.delete(name);
    log("info", "agent_killed", { name });
  }

  clearActivity(name);
  clearFileTracking(name);
  updateAgentStatus(name, "idle");
}

/**
 * Re-fork an agent using its stored spawnConfig.
 * Workspace, session ID, and mail queue are all preserved.
 * The agent resumes from the last known session ID.
 */
export function reforkAgentByName(name: string): void {
  const running = runningAgents.get(name);
  if (running) {
    // Kill the current process first
    running.removeMailListener();
    running.process.kill("SIGKILL");
    runningAgents.delete(name);
  }

  const entry = getAgent(name);
  if (!entry) throw new Error(`Agent "${name}" not found`);

  // Retrieve stored spawnOptions — fall back to reconstructing from registry
  const storedOptions = running?.spawnOptions;
  if (!storedOptions) throw new Error(`No stored spawnOptions for agent "${name}"`);

  // Resume from current session ID in registry
  const newOptions: WorkerSpawnOptions = {
    ...storedOptions,
    resumeSessionId: entry.sessionId ?? undefined,
  };

  forkAgentProcess(newOptions);
  log("info", "agent_reforked", { name });
}

// ── Status queries ────────────────────────────────────────────────────────

export function getRunningAgents(): Array<{
  name: string;
  type: AgentType;
  status: string;
  running: boolean;
}> {
  return listAgents({ status: "active" }).map(({ name, entry }) => ({
    name,
    type: entry.type,
    status: entry.status,
    running: runningAgents.has(name),
  }));
}

export function isAgentRunning(name: string): boolean {
  return runningAgents.has(name);
}

/**
 * Return the current stall state for an agent, or null if not running.
 * Used by agent-health.ts for the 3-condition stall detector.
 */
export function getAgentStallState(name: string): StallState | null {
  return runningAgents.get(name)?.stall ?? null;
}

// ── Restore on daemon restart ─────────────────────────────────────────────

export function restoreActiveAgents(
  model: string,
  _mcpServers?: Record<string, any>
): void {
  const agents = [
    ...listAgents({ status: "active" }),
    ...listAgents({ status: "idle" }),
  ];

  for (const { name, entry } of agents) {
    if (entry.type === "orchestrator" || entry.type === "scheduled") continue;

    if (!entry.sessionId) {
      log("warn", "agent_restore_skip_no_session", { agent: name });
      updateAgentStatus(name, "idle");
      continue;
    }

    const cwd =
      entry.type === "builder"
        ? entry.workspace
        : (entry as any).cwd ?? entry.sessionId;

    const workingDirectory =
      entry.type === "builder" && "workspace" in entry
        ? entry.workspace
        : cwd;

    const spawnOptions: WorkerSpawnOptions = {
      agentName: name,
      agentType: entry.type as "builder" | "helper",
      cwd,
      workingDirectory,
      model,
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"],
      epicId: "epicId" in entry ? entry.epicId : undefined,
      taskId: "taskId" in entry ? entry.taskId : undefined,
      parent: "parent" in entry ? entry.parent : undefined,
      workspace: entry.type === "builder" ? (entry as any).workspace : undefined,
      resumeSessionId: entry.sessionId,
    };

    log("info", "agent_restore", {
      agent: name,
      type: entry.type,
      sessionId: entry.sessionId,
    });

    forkAgentProcess(spawnOptions);
  }
}

// ── Daemon shutdown ───────────────────────────────────────────────────────

/**
 * Kill all running agent processes. Called during daemon shutdown.
 * Returns a promise that resolves once all processes have exited or
 * timeoutMs has elapsed (whichever comes first).
 */
export function killAllAgents(timeoutMs = 5_000): Promise<void> {
  const agents = [...runningAgents.entries()];
  if (agents.length === 0) return Promise.resolve();

  const exits = agents.map(([name, running]) => {
    running.removeMailListener();
    return new Promise<void>((resolve) => {
      running.process.once("exit", resolve);
      running.process.kill("SIGTERM");
      setTimeout(() => {
        running.process.kill("SIGKILL");
        resolve();
      }, timeoutMs);
    });
  });

  runningAgents.clear();
  return Promise.all(exits).then(() => {});
}

// ── Internal: fork worker ─────────────────────────────────────────────────

function forkAgentProcess(spawnOptions: WorkerSpawnOptions): void {
  const { agentName } = spawnOptions;

  const child = fork(WORKER_PATH, [], {
    execArgv: process.execArgv, // propagate tsx loader flags in dev mode
    stdio: ["inherit", "inherit", "pipe", "ipc"],
  });

  // Rolling 10-line stderr buffer for crash diagnostics
  const stderrLines: string[] = [];
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrLines.push(...chunk.split("\n").filter(Boolean));
      if (stderrLines.length > 10) stderrLines.splice(0, stderrLines.length - 10);
    });
  }

  const stall: StallState = {
    lastChunkAt: Date.now(),
    toolCallActive: false,
    waitingForMail: false,
    queryInFlight: false,
  };

  // Forward mail-wakeup events to the child process via IPC
  const mailEventName = `mail:${agentName}`;
  const onMailEvent = () => {
    if (child.connected) {
      child.send({ type: "mail-wakeup" } satisfies WorkerCommand);
    }
  };
  mailEvents.on(mailEventName, onMailEvent);

  const running: RunningAgent = {
    process: child,
    sessionId: spawnOptions.resumeSessionId ?? null,
    spawnOptions,
    stall,
    removeMailListener: () => mailEvents.removeListener(mailEventName, onMailEvent),
  };

  runningAgents.set(agentName, running);

  // Handle events from the worker
  child.on("message", (msg: WorkerEvent) => {
    handleWorkerEvent(agentName, msg, running);
  });

  child.on("exit", (code, signal) => {
    // Guard: only act if THIS process is still the current one in the map.
    // A refork may have already replaced it — we must not evict the new entry.
    const current = runningAgents.get(agentName);
    if (current?.process === child) {
      current.removeMailListener();
      runningAgents.delete(agentName);

      // Capture crash diagnostics on unexpected exit
      if (code !== 0 || signal) {
        setCrashInfo(agentName, {
          exitCode: typeof code === "number" ? code : null,
          stderrTail: stderrLines.slice(-10).join("\n"),
        });
      }

      // Mark idle only when this process was still the active one
      const registryEntry = getAgent(agentName);
      if (registryEntry && registryEntry.status === "active") {
        updateAgentStatus(agentName, "idle");
      }
    }
    log("info", "worker_exited", { agent: agentName, code, signal });
  });

  child.on("error", (err) => {
    log("error", "worker_process_error", {
      agent: agentName,
      error: err.message,
    });
  });

  // Send the start command with all options
  child.send({ type: "start", options: spawnOptions } satisfies WorkerCommand);

  log("info", "worker_forked", {
    agent: agentName,
    pid: child.pid,
    resuming: !!spawnOptions.resumeSessionId,
  });
}

function handleWorkerEvent(
  agentName: string,
  event: WorkerEvent,
  running: RunningAgent
): void {
  const stall = running.stall;

  switch (event.type) {
    case "query-started":
      // query() entered — request is about to be sent; agent is definitely alive.
      stall.queryInFlight = true;
      stall.lastChunkAt = Date.now();
      stall.waitingForMail = false;
      break;

    case "chunk-received":
      stall.lastChunkAt = Date.now();
      stall.toolCallActive = false;
      stall.waitingForMail = false;
      break;

    case "api-active":
      // API call is in flight — model is thinking but no output yet.
      // Resets the stall timer so the silent planning phase doesn't trigger alerts.
      stall.lastChunkAt = Date.now();
      stall.toolCallActive = false;
      stall.waitingForMail = false;
      break;

    case "tool-start":
      stall.toolCallActive = true;
      stall.waitingForMail = false;
      recordActivity(agentName);
      break;

    case "tool-end":
      stall.toolCallActive = false;
      break;

    case "mail-sent":
      stall.waitingForMail = true;
      break;

    case "session-update":
      running.sessionId = event.sessionId;
      // The daemon parent is the sole writer for the live agent registry path;
      // the worker only emits IPC events. See ideas.md "Cross-Process Registry
      // Write Race" — when the worker also wrote the registry, its sessionId
      // would get clobbered by any subsequent parent saveRegistry().
      updateAgentSession(agentName, event.sessionId);
      break;

    case "usage":
      // Usage is logged inside worker.ts via logUsage() directly.
      // Emit event bus notification for the dashboard.
      eventBus.publish({
        type: "turn:complete",
        agentName,
        sessionId: event.payload.sessionId,
      });
      break;

    case "turn-complete":
      recordActivity(agentName);
      stall.lastChunkAt = Date.now();
      stall.toolCallActive = false;
      stall.waitingForMail = false;
      stall.queryInFlight = false;
      log("info", "agent_turn_complete", { agent: agentName, sessionId: event.sessionId });
      break;

    case "status-change":
      updateAgentStatus(agentName, event.status);
      if (event.status === "active") {
        stall.waitingForMail = false;
      } else if (event.status === "idle") {
        stall.waitingForMail = true;
      }
      break;

    case "file-access":
      recordTurnFiles(agentName, event.turn, event.files);
      break;

    case "error":
      stall.queryInFlight = false;
      log("error", "worker_reported_error", { agent: agentName, message: event.message });
      updateAgentStatus(agentName, "idle");
      break;
  }
}

// ── Internal: graceful stop ───────────────────────────────────────────────

function stopAgentProcess(name: string, refork: boolean): void {
  const running = runningAgents.get(name);
  if (!running) return;

  running.removeMailListener();
  runningAgents.delete(name);

  const child = running.process;

  // Graceful: send stop command, then SIGTERM, then SIGKILL after 5s.
  // Register the exit listener BEFORE sending SIGTERM to avoid a race
  // where a fast-exiting process fires the event before the listener is set.
  const forceKillTimer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 5_000);

  child.once("exit", () => {
    clearTimeout(forceKillTimer);
    if (refork) {
      forkAgentProcess(running.spawnOptions);
    }
  });

  if (child.connected) {
    child.send({ type: "stop" } satisfies WorkerCommand);
  }
  child.kill("SIGTERM");

  log("info", "agent_loop_stopped", { agent: name });
}
