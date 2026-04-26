import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentType } from "@friday/shared";
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
import { createMailTools } from "../comms/mail-tools.js";
import { mailCheck, mailEvents, buildMailPrompt } from "../comms/mail.js";
import { logUsage } from "../monitor/usage.js";
import { log } from "../log.js";
import { recordActivity, clearActivity } from "../monitor/agent-health.js";
import { eventBus } from "../events/bus.js";

/** Tracks running agent loops by agent name */
const runningAgents = new Map<
  string,
  { abort: AbortController; sessionId: string | null }
>();

export interface CreateBuilderOptions {
  name: string;
  workingDirectory: string;
  repos: RepoSource[];
  epicId: string | null;
  model: string;
  allowedTools?: string[];
  mcpServers?: Record<string, any>;
}

export interface CreateHelperOptions {
  name: string;
  parent: string;
  taskId: string | null;
  cwd: string;
  model: string;
  allowedTools?: string[];
  mcpServers?: Record<string, any>;
}

/**
 * Initialize the Orchestrator in the registry.
 * Called once at daemon startup. Does not spawn a loop —
 * the Orchestrator's session is managed by the Slack event handler.
 */
export function initOrchestrator(): void {
  registerOrchestrator();
}

/**
 * Create a new Builder agent: register, create workspace, spawn session loop.
 */
export async function createBuilder(
  options: CreateBuilderOptions
): Promise<{ workspace: string }> {
  const {
    name,
    workingDirectory,
    repos,
    epicId,
    model,
    allowedTools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"],
    mcpServers,
  } = options;

  // Create workspace first — if this fails, we don't register
  const workspaceInfo = createWorkspace({
    builderName: name,
    workingDirectory,
    repos,
  });

  // Register in agent registry
  registerBuilder(name, "orchestrator", workspaceInfo.path, epicId);

  // Spawn the agent loop
  spawnAgentLoop({
    agentName: name,
    agentType: "builder",
    cwd: workspaceInfo.path,
    model,
    allowedTools,
    mcpServers,
    epicId,
    parent: "orchestrator",
    workspace: workspaceInfo.path,
  });

  log("info", "builder_created", {
    name,
    workspace: workspaceInfo.path,
    epicId,
    worktreeCount: workspaceInfo.worktrees.length,
  });

  return { workspace: workspaceInfo.path };
}

/**
 * Create a new Helper: register and spawn session loop.
 */
export async function createHelper(
  options: CreateHelperOptions
): Promise<void> {
  const {
    name,
    parent,
    taskId,
    cwd,
    model,
    allowedTools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"],
    mcpServers,
  } = options;

  registerHelper(name, parent, taskId, cwd);

  spawnAgentLoop({
    agentName: name,
    agentType: "helper",
    cwd,
    model,
    allowedTools,
    mcpServers,
    taskId,
    parent,
  });

  log("info", "helper_created", { name, parent, taskId, cwd });
}

/**
 * Destroy an agent: stop its loop, destroy workspace (if builder), update registry.
 */
export function destroyAgentByName(name: string): void {
  const entry = getAgent(name);
  if (!entry) {
    throw new Error(`Agent "${name}" not found`);
  }

  // Stop the running loop
  stopAgentLoop(name);
  clearActivity(name);

  // Workspace is NOT deleted here — soft delete only.
  // Workspace cleanup is a separate, user-directed action.
  if (entry.type === "builder" && entry.workspace) {
    log("info", "workspace_preserved", {
      name,
      workspace: entry.workspace,
    });
  }

  // Update registry (recursively destroys children)
  registryDestroy(name);

  log("info", "agent_destroyed_lifecycle", { name, type: entry.type });
}

/**
 * List running agents with their current state.
 */
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

/**
 * Check if an agent's loop is currently running.
 */
export function isAgentRunning(name: string): boolean {
  return runningAgents.has(name);
}

// ── Internal: Agent Loop ──────────────────────────────────────────

interface SpawnOptions {
  agentName: string;
  agentType: AgentType;
  cwd: string;
  model: string;
  allowedTools: string[];
  mcpServers?: Record<string, any>;
  epicId?: string | null;
  taskId?: string | null;
  parent?: string;
  workspace?: string;
  /** Resume an existing session instead of starting fresh */
  resumeSessionId?: string;
}

function spawnAgentLoop(options: SpawnOptions): void {
  const abort = new AbortController();
  runningAgents.set(options.agentName, {
    abort,
    sessionId: options.resumeSessionId ?? null,
  });

  // Fire and forget — the loop runs in the background
  runAgentLoop(options, abort.signal).catch((err) => {
    log("error", "agent_loop_error", {
      agent: options.agentName,
      error: err instanceof Error ? err.message : String(err),
    });
    updateAgentStatus(options.agentName, "idle");
    runningAgents.delete(options.agentName);
  });
}

async function runAgentLoop(
  options: SpawnOptions,
  signal: AbortSignal
): Promise<void> {
  const {
    agentName,
    agentType,
    cwd,
    model,
    allowedTools,
    mcpServers,
  } = options;

  const systemPrompt = buildAgentSystemPrompt({
    agentName,
    agentType,
    epicId: options.epicId,
    taskId: options.taskId,
    cwd,
    parent: options.parent,
    workspace: options.workspace,
  });

  const firstTurnPrompt = buildFirstTurnPrompt({
    agentName,
    agentType,
    epicId: options.epicId,
    taskId: options.taskId,
    cwd,
    parent: options.parent,
    workspace: options.workspace,
  });

  let sessionId = options.resumeSessionId ?? undefined;
  let prompt = sessionId ? undefined : firstTurnPrompt;

  // If resuming without a prompt, provide a check-in
  if (sessionId && !prompt) {
    prompt =
      "You have been resumed after a restart. Check your current task status " +
      "with `bd ready --json` and continue where you left off.";
  }

  // Build MCP servers — always include mail, merge with any provided servers
  const mailMcp = createMailTools({ callerName: agentName });
  const allMcpServers: Record<string, any> = {
    "friday-mail": mailMcp,
    ...mcpServers,
  };

  const queryOptions: Record<string, any> = {
    allowedTools,
    cwd,
    model,
    permissionMode: "bypassPermissions",
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: systemPrompt,
    },
    mcpServers: allMcpServers,
  };

  let turnNumber = 0;

  log("info", "agent_loop_start", { agent: agentName, resuming: !!sessionId });

  // Main agent loop: run turn → check mail → repeat until idle
  while (!signal.aborted) {
    try {
      for await (const message of query({
        prompt: prompt!,
        options: sessionId ? { ...queryOptions, resume: sessionId } : queryOptions,
      })) {
        if (signal.aborted) break;

        if (message.type === "result") {
          if (message.subtype === "success") {
            sessionId = message.session_id;
            updateAgentSession(agentName, sessionId);
            const running = runningAgents.get(agentName);
            if (running) {
              running.sessionId = sessionId;
            }

            turnNumber++;

            const usage = (message as any).usage;
            const costUsd = (message as any).total_cost_usd ?? null;
            const durationMs = (message as any).duration_ms ?? 0;

            logUsage({
              timestamp: new Date().toISOString(),
              channelId: "",
              sessionType: agentType,
              sessionId,
              model,
              costUsd,
              inputTokens: usage?.input_tokens ?? 0,
              outputTokens: usage?.output_tokens ?? 0,
              cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
              cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
              turnNumber,
              durationMs,
            });

            recordActivity(agentName);
            eventBus.publish({ type: "turn:complete", agentName, sessionId });
            log("info", "agent_turn_complete", {
              agent: agentName,
              sessionId,
            });
          } else {
            log("error", "agent_turn_failed", {
              agent: agentName,
              subtype: message.subtype,
            });
          }
        }
      }
    } catch (err) {
      log("error", "agent_loop_query_error", {
        agent: agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (signal.aborted) break;

    // Inter-turn mail check: if there's pending mail, inject it as the next prompt.
    // If no mail, go idle and wait for push notification or fallback poll.
    const mailPrompt = buildMailPrompt(agentName);
    if (mailPrompt) {
      prompt = mailPrompt;
      log("info", "agent_loop_mail_wakeup", { agent: agentName });
      continue; // Next iteration runs the turn with mail prompt
    }

    // No mail — go idle. Keep waiting until real mail arrives or abort.
    // The inner loop guards against spurious wakeups (60s fallback timer,
    // push events for already-processed messages) re-entering the outer loop
    // with a stale prompt.
    updateAgentStatus(agentName, "idle");
    log("info", "agent_loop_idle", { agent: agentName });

    while (!signal.aborted) {
      await waitForMail(agentName, signal);
      if (signal.aborted) break;

      const idleMailPrompt = buildMailPrompt(agentName);
      if (idleMailPrompt) {
        prompt = idleMailPrompt;
        updateAgentStatus(agentName, "active");
        log("info", "agent_loop_mail_wakeup_from_idle", { agent: agentName });
        break;
      }
      // Spurious wakeup: 60s timer fired with no pending mail, or a push
      // event arrived for a message already processed. Stay idle.
      log("info", "agent_loop_idle_spurious_wakeup", { agent: agentName });
    }
  }

  runningAgents.delete(agentName);
}

/**
 * Wait for mail to arrive for an agent. Resolves when:
 * 1. A mail event is emitted for this agent (push — instant), OR
 * 2. 60 seconds elapse (fallback poll for CLI-sent mail), OR
 * 3. The abort signal fires (agent destroyed)
 */
function waitForMail(agentName: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const eventName = `mail:${agentName}`;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      mailEvents.removeListener(eventName, onMail);
      signal.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
    };

    const onMail = () => {
      cleanup();
      resolve();
    };

    const onAbort = () => {
      cleanup();
      resolve();
    };

    mailEvents.on(eventName, onMail);
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 60_000);
  });
}

function stopAgentLoop(name: string): void {
  const running = runningAgents.get(name);
  if (running) {
    running.abort.abort();
    runningAgents.delete(name);
    log("info", "agent_loop_stopped", { agent: name });
  }
}

/**
 * Restore agents from the registry on daemon restart.
 * Re-spawns loops for agents that were active or idle before shutdown.
 * Active agents resume their session. Idle agents enter the mail-wait loop
 * and will wake if they have pending mail.
 */
export function restoreActiveAgents(
  model: string,
  mcpServers?: Record<string, any>
): void {
  // Restore both active and idle agents — idle agents still need
  // their loops running so they can wake on mail
  const agents = [
    ...listAgents({ status: "active" }),
    ...listAgents({ status: "idle" }),
  ];

  for (const { name, entry } of agents) {
    // Skip orchestrator — its session is managed by Slack events + mail poller
    // Skip scheduled — restored by the scheduler module
    if (entry.type === "orchestrator" || entry.type === "scheduled") continue;

    if (!entry.sessionId) {
      log("warn", "agent_restore_skip_no_session", { agent: name });
      updateAgentStatus(name, "idle");
      continue;
    }

    // Check for pending mail at boot
    const pendingMail = mailCheck(name);

    log("info", "agent_restore", {
      agent: name,
      type: entry.type,
      status: entry.status,
      sessionId: entry.sessionId,
      pendingMail: pendingMail.length,
    });

    spawnAgentLoop({
      agentName: name,
      agentType: entry.type,
      cwd:
        entry.type === "builder"
          ? entry.workspace
          : entry.cwd,
      model,
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"],
      mcpServers,
      epicId: entry.type === "builder" ? entry.epicId : undefined,
      taskId: entry.type === "helper" ? entry.taskId : undefined,
      parent: "parent" in entry ? entry.parent : undefined,
      workspace: entry.type === "builder" ? entry.workspace : undefined,
      resumeSessionId: entry.sessionId,
    });
  }
}
