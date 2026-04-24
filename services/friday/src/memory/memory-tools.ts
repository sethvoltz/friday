import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  saveEntry,
  getEntry,
  updateEntry,
  forgetEntry,
  searchMemories,
  logEvent,
} from "@friday/memory";

export interface MemoryToolsContext {
  /** Name of the agent that owns this MCP server */
  callerName: string;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/**
 * Create an MCP server with memory tools.
 * Available to the Orchestrator and Bare sessions.
 */
export function createMemoryTools(ctx: MemoryToolsContext) {
  return createSdkMcpServer({
    name: "friday-memory",
    tools: [
      tool(
        "memory_search",
        "Search persistent memory for relevant entries. Returns matches ranked by relevance " +
          "with recall frequency boosting. Use this before saving to avoid duplicates.",
        {
          query: z
            .string()
            .describe("Free-text search query — matched against titles, content, and tags"),
          tags: z
            .array(z.string())
            .optional()
            .describe("Filter to entries with ALL of these tags"),
          limit: z
            .number()
            .optional()
            .default(10)
            .describe("Maximum results to return (default: 10)"),
        },
        async ({ query, tags, limit }) => {
          const results = searchMemories({ query, tags, limit, trackRecall: true });

          logEvent({
            timestamp: new Date().toISOString(),
            event: "search",
            actor: ctx.callerName,
            query,
            resultCount: results.length,
            tags,
          });

          if (results.length === 0) {
            return ok("No matching memories found.");
          }

          const lines = results.map((r) => {
            const tagStr = r.entry.tags.length > 0 ? ` [${r.entry.tags.join(", ")}]` : "";
            return [
              `**${r.entry.title}** (id: ${r.entry.id})${tagStr}`,
              `  Score: ${r.score.toFixed(1)} | Recalled: ${r.entry.recallCount}x | Matched: ${r.matchedOn.join(", ")}`,
              `  ${r.entry.content.slice(0, 200)}${r.entry.content.length > 200 ? "..." : ""}`,
            ].join("\n");
          });

          return ok(`${results.length} result(s):\n\n${lines.join("\n\n")}`);
        }
      ),

      tool(
        "memory_save",
        "Save a new memory entry. Memories persist across sessions and conversations. " +
          "Use for decisions, context, user preferences, lessons learned — anything worth " +
          "remembering long-term. Search first to avoid duplicates.",
        {
          title: z.string().describe("Short, descriptive title"),
          content: z
            .string()
            .describe("The memory content — what to remember and why it matters"),
          tags: z
            .array(z.string())
            .optional()
            .default([])
            .describe("Tags for categorization (e.g. 'architecture', 'user-preference', 'decision')"),
        },
        async ({ title, content, tags }) => {
          const entry = saveEntry({
            title,
            content,
            tags,
            createdBy: ctx.callerName,
          });

          logEvent({
            timestamp: new Date().toISOString(),
            event: "save",
            actor: ctx.callerName,
            entryId: entry.id,
            tags: entry.tags,
          });

          return ok(`Memory saved: "${entry.title}" (id: ${entry.id})`);
        }
      ),

      tool(
        "memory_get",
        "Read a specific memory entry by its ID. Use this when you have an ID from a previous search.",
        {
          id: z.string().describe("Memory entry ID"),
        },
        async ({ id }) => {
          const entry = getEntry(id);
          if (!entry) {
            return err(`Memory "${id}" not found.`);
          }

          logEvent({
            timestamp: new Date().toISOString(),
            event: "recall",
            actor: ctx.callerName,
            entryId: id,
          });

          const tagStr = entry.tags.length > 0 ? `\nTags: ${entry.tags.join(", ")}` : "";
          return ok(
            [
              `Title: ${entry.title}`,
              `ID: ${entry.id}`,
              `Created by: ${entry.createdBy} on ${entry.createdAt}`,
              `Recalled: ${entry.recallCount}x`,
              tagStr,
              "",
              entry.content,
            ].join("\n")
          );
        }
      ),

      tool(
        "memory_forget",
        "Delete a memory entry permanently. Use when a memory is outdated, wrong, or no longer relevant.",
        {
          id: z.string().describe("Memory entry ID to delete"),
        },
        async ({ id }) => {
          const existed = forgetEntry(id);
          if (!existed) {
            return err(`Memory "${id}" not found.`);
          }

          logEvent({
            timestamp: new Date().toISOString(),
            event: "forget",
            actor: ctx.callerName,
            entryId: id,
          });

          return ok(`Memory "${id}" deleted.`);
        }
      ),
    ],
  });
}
