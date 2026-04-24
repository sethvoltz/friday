import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseLastTurns, formatTurns } from "@friday/shared";
import {
  getAgent,
  listAgents,
} from "../sessions/registry.js";
import {
  createBuilder,
  createAgentAgent,
  destroyAgentByName,
  isAgentRunning,
} from "./lifecycle.js";
import {
  addWorktreeToWorkspace,
  removeWorktreeFromWorkspace,
  destroyWorkspace,
} from "./workspace.js";
import { getLastActivity } from "../monitor/agent-health.js";

export interface AgentToolsContext {
  /** Name of the calling agent (for permission checks) */
  callerName: string;
  /** Type of the calling agent */
  callerType: "orchestrator" | "builder";
  /** Working directory from config */
  workingDirectory: string;
  /** Model to use for spawned agents */
  model: string;
  /** MCP servers to pass to spawned agents */
  mcpServers?: Record<string, any>;
  /**
   * Optional callback to post a message to Slack.
   * Used by the Orchestrator so that agent_create can confirm dispatch directly,
   * removing the model's motivation to continue its turn.
   */
  postToSlack?: (text: string) => Promise<void>;
  /** Slack channel ID for postToSlack */
  slackChannelId?: string;
}

/**
 * Creates MCP tools for agent lifecycle and workspace management.
 * Permission-scoped: Orchestrator gets full access, Builders get child-only access.
 */
export function createAgentTools(ctx: AgentToolsContext) {
  return createSdkMcpServer({
    name: "friday-agents",
    tools: [
      // ── Agent Management ──────────────────────────────────────

      tool(
        "agent_create",
        "Create a new Builder or Agent. " +
          "Orchestrator can create Builders (with workspace and optional epic) or Agents. " +
          "Builders can only create Agents within their own workspace. " +
          "For Builders: provide repos (list of repo paths or URLs) to set up workspaces with git worktrees. " +
          "For Agents: provide the working directory (cwd) where the agent should operate.",
        {
          type: z.enum(["builder", "agent"]).describe("Type of agent to create"),
          name: z
            .string()
            .describe(
              "Agent name. Must be lowercase alphanumeric with hyphens (e.g., 'builder-auth', 'agent-lint-check')"
            ),
          epic_id: z
            .string()
            .nullable()
            .optional()
            .describe("Beads epic ID for Builders (e.g., 'bd-a1b2'). Null if no epic assigned yet."),
          task_id: z
            .string()
            .nullable()
            .optional()
            .describe("Beads task ID for Agents (e.g., 'bd-c3d4'). Null if no task assigned yet."),
          repos: z
            .array(
              z.object({
                repo: z.string().describe("Local path or remote URL (HTTPS/SSH/gh shorthand)"),
                branch: z.string().optional().describe("Branch name for the worktree"),
              })
            )
            .optional()
            .describe("Repos to set up in the Builder's workspace. Required for Builders."),
          cwd: z
            .string()
            .optional()
            .describe("Working directory for an Agent. Defaults to the caller's workspace."),
        },
        async (args) => {
          try {
            if (args.type === "builder") {
              if (ctx.callerType !== "orchestrator") {
                return errorResult("Only the Orchestrator can create Builders.");
              }
              if (!args.repos || args.repos.length === 0) {
                return errorResult("Builders require at least one repo.");
              }

              // Builders get their own agent tools scoped to their identity
              const builderMcp = createAgentTools({
                callerName: args.name,
                callerType: "builder",
                workingDirectory: ctx.workingDirectory,
                model: ctx.model,
              });
              const builderMcpServers: Record<string, any> = {
                ...ctx.mcpServers,
                "friday-agents": builderMcp,
              };

              const result = await createBuilder({
                name: args.name,
                workingDirectory: ctx.workingDirectory,
                repos: args.repos,
                epicId: args.epic_id ?? null,
                model: ctx.model,
                mcpServers: builderMcpServers,
              });

              // Post confirmation to Slack directly so the model doesn't need to
              if (ctx.postToSlack) {
                await ctx.postToSlack(
                  `\u{1F528} Builder *${args.name}* created and working in \`${result.workspace}\`` +
                    (args.epic_id ? ` on epic \`${args.epic_id}\`` : "") +
                    `. It will work independently — I'll check on it when asked.`
                ).catch(() => {});
              }

              return okResult(
                `Builder "${args.name}" created and running in background.\n` +
                  `Workspace: ${result.workspace}\n` +
                  `Epic: ${args.epic_id ?? "none"}\n\n` +
                  `A confirmation has been posted to Slack.\n` +
                  `YOUR TURN IS DONE. Respond briefly and stop. Do NOT do the builder's work.`
              );
            }

            // Agent creation
            const callerEntry = getAgent(ctx.callerName);
            const agentCwd =
              args.cwd ??
              (callerEntry && "workspace" in callerEntry
                ? callerEntry.workspace
                : undefined);

            if (!agentCwd) {
              return errorResult(
                "No working directory specified and caller has no workspace."
              );
            }

            await createAgentAgent({
              name: args.name,
              parent: ctx.callerName,
              taskId: args.task_id ?? null,
              cwd: agentCwd,
              model: ctx.model,
              mcpServers: ctx.mcpServers,
            });

            if (ctx.postToSlack) {
              await ctx.postToSlack(
                `\u{26A1} Agent *${args.name}* spawned` +
                  (args.task_id ? ` on task \`${args.task_id}\`` : "") +
                  `. Running independently.`
              ).catch(() => {});
            }

            return okResult(
              `Agent "${args.name}" created and running in background.\n` +
                `Parent: ${ctx.callerName}\n` +
                `Task: ${args.task_id ?? "none"}\n` +
                `CWD: ${agentCwd}\n\n` +
                `YOUR TURN IS DONE. Respond briefly and stop. Do NOT do the agent's work.`
            );
          } catch (err) {
            return errorResult(errMsg(err));
          }
        }
      ),

      tool(
        "agent_list",
        "List agents. Orchestrator sees all agents. Builders see only their own children.",
        {
          status: z
            .enum(["active", "idle", "destroyed"])
            .optional()
            .describe("Filter by status. Omit to see all."),
          type: z
            .enum(["orchestrator", "builder", "agent"])
            .optional()
            .describe("Filter by agent type."),
        },
        async (args) => {
          try {
            const filter: Record<string, any> = {};
            if (args.status) filter.status = args.status;
            if (args.type) filter.type = args.type;

            // Builders only see their own children
            if (ctx.callerType === "builder") {
              filter.parent = ctx.callerName;
            }

            const agents = listAgents(filter);
            if (agents.length === 0) {
              return okResult("No agents found matching the filter.");
            }

            const lines = agents.map(({ name, entry }) => {
              const running = isAgentRunning(name);
              const parts = [
                `${name} (${entry.type})`,
                `status=${entry.status}`,
                running ? "loop=running" : "loop=stopped",
              ];
              if ("epicId" in entry && entry.epicId) parts.push(`epic=${entry.epicId}`);
              if ("taskId" in entry && entry.taskId) parts.push(`task=${entry.taskId}`);
              if ("workspace" in entry) parts.push(`workspace=${entry.workspace}`);
              if ("children" in entry && entry.children.length > 0)
                parts.push(`children=[${entry.children.join(", ")}]`);
              return parts.join(" | ");
            });

            return okResult(lines.join("\n"));
          } catch (err) {
            return errorResult(errMsg(err));
          }
        }
      ),

      tool(
        "agent_status",
        "Get detailed status of a specific agent including session info, task, and workspace.",
        {
          name: z.string().describe("Name of the agent to inspect"),
        },
        async (args) => {
          try {
            const entry = getAgent(args.name);
            if (!entry) {
              return errorResult(`Agent "${args.name}" not found.`);
            }

            // Builders can only inspect their own children
            if (
              ctx.callerType === "builder" &&
              "parent" in entry &&
              entry.parent !== ctx.callerName
            ) {
              return errorResult(
                `Builder "${ctx.callerName}" cannot inspect agent "${args.name}" (not a child).`
              );
            }

            const info: Record<string, any> = {
              name: args.name,
              type: entry.type,
              status: entry.status,
              running: isAgentRunning(args.name),
              sessionId: entry.sessionId,
              createdAt: entry.createdAt,
            };

            if ("parent" in entry) info.parent = entry.parent;
            if ("workspace" in entry) info.workspace = entry.workspace;
            if ("epicId" in entry) info.epicId = entry.epicId;
            if ("taskId" in entry) info.taskId = entry.taskId;
            if ("cwd" in entry) info.cwd = entry.cwd;
            if ("children" in entry) info.children = entry.children;

            return okResult(JSON.stringify(info, null, 2));
          } catch (err) {
            return errorResult(errMsg(err));
          }
        }
      ),

      tool(
        "agent_destroy",
        "Destroy an agent, stopping its loop and cleaning up its workspace (if Builder). " +
          "Builders can only destroy their own Agents. " +
          "Recursively destroys any children of the target agent.",
        {
          name: z.string().describe("Name of the agent to destroy"),
        },
        async (args) => {
          try {
            const entry = getAgent(args.name);
            if (!entry) {
              return errorResult(`Agent "${args.name}" not found.`);
            }

            if (args.name === "orchestrator") {
              return errorResult("Cannot destroy the Orchestrator.");
            }

            // Builders can only destroy their own children
            if (ctx.callerType === "builder") {
              if (!("parent" in entry) || entry.parent !== ctx.callerName) {
                return errorResult(
                  `Builder "${ctx.callerName}" can only destroy its own children.`
                );
              }
            }

            destroyAgentByName(args.name);
            return okResult(`Agent "${args.name}" destroyed.`);
          } catch (err) {
            return errorResult(errMsg(err));
          }
        }
      ),

      // ── Agent Inspection ──────────────────────────────────────

      tool(
        "agent_inspect",
        "Read the last N turns from a child agent's session transcript. " +
          "This is the equivalent of peering into a tmux session — see what the agent has been doing, " +
          "what tools it called, and what it said. Use this when checking on an agent's progress " +
          "or diagnosing why it's stuck.",
        {
          name: z.string().describe("Name of the agent to inspect"),
          turns: z
            .number()
            .optional()
            .default(5)
            .describe("Number of recent turns to show (default: 5)"),
          include_tools: z
            .boolean()
            .optional()
            .default(true)
            .describe("Include tool call names in output (default: true)"),
        },
        async (args) => {
          try {
            const entry = getAgent(args.name);
            if (!entry) {
              return errorResult(`Agent "${args.name}" not found.`);
            }

            // Builders can only inspect their own children
            if (
              ctx.callerType === "builder" &&
              "parent" in entry &&
              entry.parent !== ctx.callerName
            ) {
              return errorResult(
                `Builder "${ctx.callerName}" cannot inspect agent "${args.name}" (not a child).`
              );
            }

            if (!entry.sessionId) {
              return errorResult(`Agent "${args.name}" has no session yet.`);
            }

            // Derive the session JSONL path from the agent's CWD and session ID
            const agentCwd =
              entry.type === "builder" && "workspace" in entry
                ? entry.workspace
                : "cwd" in entry
                  ? entry.cwd
                  : null;

            if (!agentCwd) {
              return errorResult(`Cannot determine working directory for agent "${args.name}".`);
            }

            const encodedCwd = agentCwd.replace(/\//g, "-");
            const jsonlPath = join(
              homedir(),
              ".claude",
              "projects",
              encodedCwd,
              `${entry.sessionId}.jsonl`
            );

            if (!existsSync(jsonlPath)) {
              return errorResult(
                `Session transcript not found at ${jsonlPath}. ` +
                  `The agent may not have completed any turns yet.`
              );
            }

            const turns = await parseLastTurns(jsonlPath, args.turns);
            if (turns.length === 0) {
              return okResult(`Agent "${args.name}" has no turns in its transcript yet.`);
            }

            const lastActivityMs = getLastActivity(args.name);
            const lastActivityStr = lastActivityMs
              ? `${Math.round((Date.now() - lastActivityMs) / 1000)}s ago`
              : "unknown";

            const header = [
              `Agent: ${args.name} (${entry.type})`,
              `Status: ${entry.status} | Loop: ${isAgentRunning(args.name) ? "running" : "stopped"}`,
              `Last activity: ${lastActivityStr}`,
              `Showing last ${turns.length} of transcript:`,
              "",
            ].join("\n");

            const body = formatTurns(turns, { includeTools: args.include_tools });

            return okResult(header + body);
          } catch (err) {
            return errorResult(errMsg(err));
          }
        }
      ),

      // ── Workspace Management ──────────────────────────────────

      tool(
        "worktree_add",
        "Add a git worktree to an existing Builder workspace. " +
          "Use this to add additional repositories to a Builder's workspace after creation. " +
          "The repo can be a local path or remote URL (HTTPS/SSH/gh shorthand like 'org/repo').",
        {
          workspace: z.string().describe("Absolute path to the workspace"),
          repo: z.string().describe("Local path or remote URL"),
          branch: z.string().optional().describe("Branch name for the worktree"),
          builder_name: z
            .string()
            .describe("Name of the builder that owns this workspace"),
        },
        async (args) => {
          try {
            // Permission check: builders can only modify their own workspace
            if (ctx.callerType === "builder") {
              const callerEntry = getAgent(ctx.callerName);
              if (
                callerEntry &&
                "workspace" in callerEntry &&
                callerEntry.workspace !== args.workspace
              ) {
                return errorResult("Builders can only modify their own workspace.");
              }
            }

            const result = addWorktreeToWorkspace(
              args.workspace,
              { repo: args.repo, branch: args.branch },
              args.builder_name
            );

            return okResult(
              `Worktree added.\n` +
                `Name: ${result.name}\n` +
                `Path: ${result.path}\n` +
                `Branch: ${result.branch}\n` +
                `Source: ${result.source}`
            );
          } catch (err) {
            return errorResult(errMsg(err));
          }
        }
      ),

      tool(
        "worktree_remove",
        "Remove a git worktree from a Builder workspace.",
        {
          workspace: z.string().describe("Absolute path to the workspace"),
          worktree_name: z.string().describe("Name of the worktree directory to remove"),
        },
        async (args) => {
          try {
            if (ctx.callerType === "builder") {
              const callerEntry = getAgent(ctx.callerName);
              if (
                callerEntry &&
                "workspace" in callerEntry &&
                callerEntry.workspace !== args.workspace
              ) {
                return errorResult("Builders can only modify their own workspace.");
              }
            }

            removeWorktreeFromWorkspace(args.workspace, args.worktree_name);
            return okResult(`Worktree "${args.worktree_name}" removed from workspace.`);
          } catch (err) {
            return errorResult(errMsg(err));
          }
        }
      ),

      tool(
        "workspace_cleanup",
        "Clean up a Builder's workspace directory, properly removing git worktrees before deleting. " +
          "Use this after a Builder is destroyed and the user confirms workspace deletion. " +
          "This is the safe way to remove workspaces — it detaches worktrees from their source repos " +
          "before deleting files, preventing dangling worktree references. " +
          "Only the Orchestrator can use this tool.",
        {
          workspace: z.string().describe("Absolute path to the workspace to clean up"),
          builder_name: z
            .string()
            .describe("Name of the builder whose workspace this is (for logging/confirmation)"),
        },
        async (args) => {
          try {
            if (ctx.callerType !== "orchestrator") {
              return errorResult("Only the Orchestrator can clean up workspaces.");
            }

            // Safety: check that the agent is actually destroyed
            const entry = getAgent(args.builder_name);
            if (entry && entry.status !== "destroyed") {
              return errorResult(
                `Builder "${args.builder_name}" is still ${entry.status}. ` +
                  `Destroy it first with agent_destroy before cleaning up the workspace.`
              );
            }

            if (!existsSync(args.workspace)) {
              return okResult(`Workspace "${args.workspace}" does not exist (already cleaned up).`);
            }

            destroyWorkspace(args.workspace);
            return okResult(
              `Workspace "${args.workspace}" cleaned up. ` +
                `Git worktrees were properly detached before removal.`
            );
          } catch (err) {
            return errorResult(errMsg(err));
          }
        }
      ),
    ],
  });
}

// ── Helpers ──────────────────────────────────────────────────

function okResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
