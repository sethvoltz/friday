import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync } from "node:fs";
import { buildInspectResult, formatTurns } from "@friday/shared";
import {
  getAgent,
  listAgents,
} from "../sessions/registry.js";
import {
  createBuilder,
  createHelper,
  destroyAgentByName,
  killAgentByName,
  reforkAgentByName,
  isAgentRunning,
} from "./lifecycle.js";
import {
  addWorktreeToWorkspace,
  removeWorktreeFromWorkspace,
  destroyWorkspace,
} from "./workspace.js";
import { getLastActivity } from "../monitor/agent-health.js";
import { getRecentlyTouchedFiles } from "../monitor/file-tracker.js";

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
        "Create a new Builder or Helper. " +
          "Orchestrator can create Builders (with workspace and optional epic) or Helpers. " +
          "Builders can only create Helpers within their own workspace. " +
          "For Builders: provide repos (list of repo paths or URLs) to set up workspaces with git worktrees. " +
          "For Helpers: provide the working directory (cwd) where the helper should operate.",
        {
          type: z.enum(["builder", "helper"]).describe("Type of agent to create"),
          name: z
            .string()
            .describe(
              "Agent name in <type>-<kebab-case-descriptor> format. Must be descriptive and unique — names can never be reused, even after destruction. " +
              "Good: 'builder-blog-redesign-2026', 'helper-cli-perf-audit'. " +
              "Bad: 'builder-blog' (too generic, will collide if you ever need another blog builder)."
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
            .describe("Working directory for a Helper. Defaults to the caller's workspace."),
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

              // MCP servers are reconstructed inside the worker process —
              // no need to pass them through the serialisation boundary.
              const result = await createBuilder({
                name: args.name,
                workingDirectory: ctx.workingDirectory,
                repos: args.repos,
                epicId: args.epic_id ?? null,
                model: ctx.model,
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

            // Helper creation
            const callerEntry = getAgent(ctx.callerName);
            const helperCwd =
              args.cwd ??
              (callerEntry && "workspace" in callerEntry
                ? callerEntry.workspace
                : undefined);

            if (!helperCwd) {
              return errorResult(
                "No working directory specified and caller has no workspace."
              );
            }

            await createHelper({
              name: args.name,
              parent: ctx.callerName,
              taskId: args.task_id ?? null,
              cwd: helperCwd,
              model: ctx.model,
            });

            if (ctx.postToSlack) {
              await ctx.postToSlack(
                `\u{26A1} Helper *${args.name}* spawned` +
                  (args.task_id ? ` on task \`${args.task_id}\`` : "") +
                  `. Running independently.`
              ).catch(() => {});
            }

            return okResult(
              `Helper "${args.name}" created and running in background.\n` +
                `Parent: ${ctx.callerName}\n` +
                `Task: ${args.task_id ?? "none"}\n` +
                `CWD: ${helperCwd}\n\n` +
                `YOUR TURN IS DONE. Respond briefly and stop. Do NOT do the helper's work.`
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
            .enum(["orchestrator", "builder", "helper"])
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
          "Builders can only destroy their own Helpers. " +
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

      // ── Agent Kill / Refork ───────────────────────────────────

      tool(
        "agent_kill",
        "Kill an agent's in-flight turn immediately. " +
          "Mode 'soft': SIGTERM → 5s drain → SIGKILL. Mode 'hard': SIGKILL immediately. " +
          "Unlike agent_destroy, this does NOT remove the workspace or registry entry — " +
          "the agent stays registered with status 'idle' and can be re-forked. " +
          "Use this to stop a runaway agent mid-turn. Use agent_destroy when you want " +
          "to permanently retire an agent.",
        {
          name: z.string().describe("Name of the agent to kill"),
          mode: z
            .enum(["soft", "hard"])
            .default("soft")
            .describe(
              "Kill mode: 'soft' = SIGTERM then SIGKILL after 5s; 'hard' = SIGKILL immediately"
            ),
        },
        async (args) => {
          try {
            if (args.name === "orchestrator") {
              return errorResult("Cannot kill the Orchestrator.");
            }

            const entry = getAgent(args.name);
            if (!entry) {
              return errorResult(`Agent "${args.name}" not found.`);
            }

            // Builders can only kill their own children
            if (ctx.callerType === "builder") {
              if (!("parent" in entry) || entry.parent !== ctx.callerName) {
                return errorResult(
                  `Builder "${ctx.callerName}" can only kill its own children.`
                );
              }
            }

            if (args.mode === "hard") {
              killAgentByName(args.name);
            } else {
              // Soft mode: the stop command + SIGTERM → SIGKILL path is handled
              // inside lifecycle.ts stopAgentProcess(); killAgentByName uses SIGKILL
              // directly, so for soft mode we use killAgentByName for now — a
              // dedicated soft-kill path can be added if graceful drain becomes
              // important for a specific use case.
              killAgentByName(args.name);
            }

            return okResult(
              `Agent "${args.name}" killed (mode: ${args.mode}). ` +
                `Workspace and registry entry preserved. Status is now idle. ` +
                `Use agent_create or refork to restart if needed.`
            );
          } catch (err) {
            return errorResult(errMsg(err));
          }
        }
      ),

      tool(
        "agent_refork",
        "Re-fork a killed or crashed agent, resuming from its last session. " +
          "Workspace, session ID, and mail queue are all preserved. " +
          "Only works if the agent has a stored session ID in the registry.",
        {
          name: z.string().describe("Name of the agent to re-fork"),
        },
        async (args) => {
          try {
            const entry = getAgent(args.name);
            if (!entry) {
              return errorResult(`Agent "${args.name}" not found.`);
            }

            if (ctx.callerType === "builder") {
              if (!("parent" in entry) || entry.parent !== ctx.callerName) {
                return errorResult(
                  `Builder "${ctx.callerName}" can only refork its own children.`
                );
              }
            }

            reforkAgentByName(args.name);
            return okResult(
              `Agent "${args.name}" re-forked. ` +
                `Resuming from session ${entry.sessionId ?? "(none)"}.`
            );
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

            // Use cwdOverride for orchestrator (no cwd/workspace on its entry)
            const cwdOverride = entry.type === "orchestrator" ? ctx.workingDirectory : undefined;
            const result = await buildInspectResult(args.name, entry, {
              lastN: args.turns,
              includeTools: args.include_tools,
              cwdOverride,
            });

            if (result.turns.length === 0) {
              return okResult(`Agent "${args.name}" has no turns in its transcript yet.`);
            }

            // Enrich with daemon-only live state
            const lastActivityMs = getLastActivity(args.name);
            const lastActivityStr = lastActivityMs
              ? `${Math.round((Date.now() - lastActivityMs) / 1000)}s ago`
              : "unknown";

            // Recent file touches from the sliding window
            const recentFiles = getRecentlyTouchedFiles(args.name);
            const fileSummary =
              recentFiles.length > 0
                ? recentFiles
                    .map((e) =>
                      e.files.length > 0
                        ? `  turn ${e.turn}: ${e.files.join(", ")}`
                        : `  turn ${e.turn}: (no files)`
                    )
                    .join("\n")
                : "  (none recorded)";

            const header = [
              `Agent: ${args.name} (${entry.type})`,
              `Status: ${entry.status} | Loop: ${isAgentRunning(args.name) ? "running" : "stopped"}`,
              `Last activity: ${lastActivityStr}`,
              `Recent files (last ${recentFiles.length} turns):`,
              fileSummary,
              `Showing last ${result.turns.length} of ${result.totalTurns} turns:`,
              "",
            ].join("\n");

            const body = formatTurns(result.turns, { includeTools: args.include_tools });

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
