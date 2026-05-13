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

interface BlockRow {
  id: number;
  blockId: string;
  turnId: string;
  sessionId: string;
  agentName: string;
  role: string;
  kind: string;
  source: string | null;
  contentJson: string;
  status: string;
  ts: number;
}

const INSPECT_BLOCK_PREVIEW_CHARS = 320;

function formatBlocksAsMarkdown(agentName: string, blocks: BlockRow[]): string {
  if (blocks.length === 0) return `_No blocks yet for \`${agentName}\`._`;
  // /api/agents/:name/blocks returns desc by id; render oldest-first for reading.
  const ordered = [...blocks].sort((a, b) => a.id - b.id);
  const lines: string[] = [`# ${agentName} — last ${ordered.length} blocks\n`];
  for (const b of ordered) {
    const ts = new Date(b.ts).toISOString();
    lines.push(
      `## ${b.role} • ${b.kind} • ${ts} • block ${b.blockId.slice(0, 8)} (turn ${b.turnId.slice(0, 8)}) • ${b.status}`,
    );
    lines.push("");
    lines.push(summarizeBlock(b));
    lines.push("");
  }
  return lines.join("\n");
}

function summarizeBlock(b: BlockRow): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(b.contentJson) as Record<string, unknown>;
  } catch {
    return truncate(b.contentJson);
  }
  if (b.kind === "text") {
    return truncate(String(parsed.text ?? ""));
  }
  if (b.kind === "thinking") {
    return `*[thinking]* ${truncate(String(parsed.text ?? ""))}`;
  }
  if (b.kind === "tool_use") {
    const name = String(parsed.name ?? "?");
    const input = JSON.stringify(parsed.input ?? {});
    const toolId = String(parsed.tool_use_id ?? "");
    return `🔧 \`${name}\`(${truncate(input, 120)}) — id=${toolId.slice(0, 8)}`;
  }
  if (b.kind === "tool_result") {
    const result =
      typeof parsed.text === "string"
        ? parsed.text
        : JSON.stringify(parsed.text ?? "");
    return `↳ tool_result (${parsed.is_error ? "error" : "ok"}): ${truncate(result)}`;
  }
  return truncate(b.contentJson, 200);
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
        "Read recent content blocks from a sub-agent's transcript. Default `markdown` format gives a compact human-readable summary; pass `format: 'json'` for raw block rows.",
        {
          name: z.string(),
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe("Max number of blocks. Default 30."),
          format: z
            .enum(["markdown", "json"])
            .optional()
            .describe("Default `markdown`."),
        },
        async (args) => {
          const params = new URLSearchParams();
          params.set("limit", String(args.limit ?? 30));
          const qs = `?${params.toString()}`;
          const payload = (await daemonFetch({
            ...ctx,
            path: `/api/agents/${encodeURIComponent(args.name)}/blocks${qs}`,
          })) as { blocks: BlockRow[] };
          const blocks = payload.blocks ?? [];
          if (args.format === "json") {
            return {
              content: [{ type: "text", text: JSON.stringify(blocks, null, 2) }],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: formatBlocksAsMarkdown(args.name, blocks),
              },
            ],
          };
        },
      ),
      tool(
        "agent_delete_workspace",
        // FIX_FORWARD 6.4: the deletion language is the contract. The
        // model MUST NOT autonomously invoke this tool. Every call must
        // be preceded by an explicit user "yes" in the conversation.
        "Permanently delete a builder's workspace — both the git worktree and the parent folder under `~/.friday/workspaces/<name>/`. NEVER auto-invoke this tool. Always present the proposed deletion to the user (which agent, which workspace path) and wait for explicit confirmation before calling. The user MUST say yes by message before this tool is called. Suitable only after the builder has been killed and its branch is merged or abandoned. The daemon double-checks that the resolved path is inside `~/.friday/workspaces/` before any filesystem op.",
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
