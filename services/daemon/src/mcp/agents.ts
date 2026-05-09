/**
 * Friday-agents MCP server. The orchestrator's interface for spawning,
 * inspecting, and killing sub-agents.
 *
 * Hard-gated by callerType — only orchestrator gets the write surface in the
 * default phasing. Builder/helper/bare/scheduled don't see agent_* at all so
 * they can't accidentally fall back to it.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentType } from "@friday/shared";
import { daemonFetch } from "./http.js";

interface TurnRow {
  id: number;
  sessionId: string;
  agentName: string | null;
  turnIndex: number;
  ts: number;
  role: string;
  kind: string;
  contentJson: string;
}

const INSPECT_BLOCK_PREVIEW_CHARS = 320;

function formatTurnsAsMarkdown(agentName: string, turns: TurnRow[]): string {
  if (turns.length === 0) return `_No turns yet for \`${agentName}\`._`;
  // /api/agents/:name/turns returns desc by id; render oldest-first for reading.
  const ordered = [...turns].reverse();
  const lines: string[] = [`# ${agentName} — last ${ordered.length} turns\n`];
  for (const t of ordered) {
    const ts = new Date(t.ts).toISOString();
    lines.push(`## ${t.role} • ${t.kind} • ${ts} • turn ${t.id}`);
    lines.push("");
    lines.push(...summarizeContent(t.contentJson));
    lines.push("");
  }
  return lines.join("\n");
}

function summarizeContent(contentJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return [truncate(contentJson)];
  }
  const obj = parsed as Record<string, unknown>;
  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        out.push(truncate(block.text));
      } else if (block.type === "thinking") {
        out.push(`*[thinking]* ${truncate(String(block.thinking ?? ""))}`);
      } else if (block.type === "tool_use") {
        const name = String(block.name ?? "?");
        const input = JSON.stringify(block.input ?? {});
        out.push(
          `🔧 \`${name}\`(${truncate(input, 120)}) — id=${String(block.id ?? "")}`,
        );
      } else if (block.type === "tool_result") {
        const result =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
        out.push(
          `↳ tool_result (${block.is_error ? "error" : "ok"}): ${truncate(result)}`,
        );
      }
    }
    return out.length > 0 ? out : ["_(empty)_"];
  }
  if (typeof message?.content === "string") {
    return [truncate(message.content as string)];
  }
  return [truncate(contentJson, 200)];
}

function truncate(s: string, max = INSPECT_BLOCK_PREVIEW_CHARS): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + "…";
}

export const AGENTS_SERVER_NAME = "friday-agents";

export interface BuildAgentsServerOptions {
  callerName: string;
  callerType: AgentType;
  daemonPort: number;
  parentName?: string;
}

export function buildAgentsServer(opts: BuildAgentsServerOptions) {
  const ctx = {
    port: opts.daemonPort,
    callerName: opts.callerName,
    callerType: opts.callerType,
  };

  return createSdkMcpServer({
    name: AGENTS_SERVER_NAME,
    tools: [
      tool(
        "agent_create",
        "Spawn a new sub-agent in its own forked process. Returns immediately — the sub-agent runs asynchronously and reports back via mail. Do NOT wait synchronously; let the user know you've spawned it and continue.",
        {
          type: z
            .enum(["builder", "helper", "bare"])
            .describe("Sub-agent type. Builders get a fresh git worktree."),
          name: z
            .string()
            .describe(
              "Unique agent name. Lowercase alphanumeric + dashes, up to 64 chars.",
            ),
          prompt: z
            .string()
            .describe(
              "First-turn instructions for the new agent. Be specific about deliverable + how to report back.",
            ),
          model: z.string().optional().describe("Override model. Optional."),
          ticketId: z
            .string()
            .optional()
            .describe("Linked ticket id, if any."),
          worktree: z
            .object({
              repo: z
                .string()
                .optional()
                .describe(
                  "Path to the base git repo. Defaults to the daemon's cwd.",
                ),
              branch: z
                .string()
                .optional()
                .describe(
                  "Branch name to create for the builder. Defaults to `friday/<name>`.",
                ),
            })
            .optional()
            .describe(
              "Builder-only. Specifies which repo / branch the worktree is cut from.",
            ),
        },
        async (args) => {
          const row = await daemonFetch({
            ...ctx,
            path: "/api/agents",
            method: "POST",
            body: {
              type: args.type,
              name: args.name,
              parentName: opts.callerName,
              prompt: args.prompt,
              model: args.model,
              ticketId: args.ticketId,
              worktree: args.worktree,
            },
          });
          return {
            content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
          };
        },
      ),
      tool(
        "agent_list",
        "List registered agents, optionally filtered by type or status.",
        {
          type: z
            .enum(["orchestrator", "builder", "helper", "scheduled", "bare"])
            .optional(),
          status: z
            .enum(["idle", "working", "stalled", "error", "killed"])
            .optional(),
        },
        async (args) => {
          const params = new URLSearchParams();
          if (args.type) params.set("type", args.type);
          if (args.status) params.set("status", args.status);
          const qs = params.toString() ? `?${params.toString()}` : "";
          const rows = await daemonFetch({
            ...ctx,
            path: `/api/agents${qs}`,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          };
        },
      ),
      tool(
        "agent_status",
        "Look up one agent's registry record.",
        { name: z.string() },
        async (args) => {
          const row = await daemonFetch({
            ...ctx,
            path: `/api/agents/${encodeURIComponent(args.name)}`,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
          };
        },
      ),
      tool(
        "agent_kill",
        "Kill a sub-agent. The worker is signalled to stop and the registry row is marked killed.",
        { name: z.string() },
        async (args) => {
          await daemonFetch({
            ...ctx,
            path: `/api/agents/${encodeURIComponent(args.name)}/kill`,
            method: "POST",
          });
          return {
            content: [{ type: "text", text: `agent ${args.name} killed` }],
          };
        },
      ),
      tool(
        "agent_inspect",
        "Read recent turns from a sub-agent's transcript. Default `markdown` format gives a compact human-readable summary; pass `format: 'json'` for raw turn rows.",
        {
          name: z.string(),
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe("Max number of turns. Default 30."),
          format: z
            .enum(["markdown", "json"])
            .optional()
            .describe("Default `markdown`."),
        },
        async (args) => {
          const params = new URLSearchParams();
          params.set("limit", String(args.limit ?? 30));
          const qs = `?${params.toString()}`;
          const turns = (await daemonFetch({
            ...ctx,
            path: `/api/agents/${encodeURIComponent(args.name)}/turns${qs}`,
          })) as TurnRow[];
          if (args.format === "json") {
            return {
              content: [{ type: "text", text: JSON.stringify(turns, null, 2) }],
            };
          }
          return {
            content: [
              { type: "text", text: formatTurnsAsMarkdown(args.name, turns) },
            ],
          };
        },
      ),
      tool(
        "workspace_cleanup",
        "Remove a builder's git worktree once its work has merged. Only call after the builder is killed and its branch is merged or abandoned.",
        { name: z.string().describe("Builder agent name.") },
        async (args) => {
          const row = await daemonFetch({
            ...ctx,
            path: `/api/agents/${encodeURIComponent(args.name)}/workspace`,
            method: "DELETE",
          });
          return {
            content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
          };
        },
      ),
    ],
  });
}
