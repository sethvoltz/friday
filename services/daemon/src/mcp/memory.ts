/**
 * Friday-memory MCP server. Read+write surface over `@friday/memory`'s
 * filesystem-backed store at `~/.friday/memory/entries/<id>.md` (mirrored
 * into the FTS5-indexed `memory_entries` SQLite table).
 *
 * Builders get a read-only subset — they shouldn't be writing canonical
 * memory; they mail the orchestrator who decides what's worth keeping.
 *
 * Disables the SDK's built-in `autoMemoryEnabled` over in worker.ts so the
 * model can't accidentally fall back to the project-scoped `~/.claude/...`
 * memory directory.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentType } from "@friday/shared";
import { daemonFetch } from "./http.js";

export const MEMORY_SERVER_NAME = "friday-memory";

export interface BuildMemoryServerOptions {
  callerName: string;
  callerType: AgentType;
  daemonPort: number;
}

export function buildMemoryServer(opts: BuildMemoryServerOptions) {
  const ctx = {
    port: opts.daemonPort,
    callerName: opts.callerName,
    callerType: opts.callerType,
  };
  const writable = opts.callerType !== "builder";

  const searchTool = tool(
    "memory_search",
    "Search Friday's memory store. Returns matched entries with title, id, score, and matchedOn. Use memory_get for full content.",
    {
      query: z.string().describe("Free-form text query. Required."),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          "Optional tag filter; entries must include all listed tags.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results. Default 10."),
    },
    async (args) => {
      const params = new URLSearchParams();
      params.set("q", args.query);
      if (args.tags && args.tags.length > 0)
        params.set("tags", args.tags.join(","));
      if (args.limit) params.set("limit", String(args.limit));
      const rows = await daemonFetch({
        ...ctx,
        path: `/api/memory/search?${params.toString()}`,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      };
    },
  );

  const getTool = tool(
    "memory_get",
    "Read a memory entry in full. Bumps its recall counter so the FTS ranker learns which memories are useful.",
    { id: z.string().describe("Memory entry id (slug).") },
    async (args) => {
      const row = await daemonFetch({
        ...ctx,
        path: `/api/memory/${encodeURIComponent(args.id)}`,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
      };
    },
  );

  const saveTool = tool(
    "memory_save",
    "Save a fact, preference, decision, or note that future Friday conversations should remember. Friday's store at `~/.friday/memory/entries/`. **Do not use the built-in Memory tool** — Friday's `autoMemoryEnabled` is disabled and the SDK's project-scoped memory directory is not Friday's store.",
    {
      id: z
        .string()
        .optional()
        .describe(
          "Optional slug. Auto-derived from title if omitted. If an entry with this id already exists it is overwritten — pass an explicit id only when you want to update.",
        ),
      title: z.string().describe("Short human-readable title."),
      content: z
        .string()
        .describe("Full markdown body. Be concise but complete."),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags for retrieval. Lowercase, no spaces."),
    },
    async (args) => {
      const row = await daemonFetch({
        ...ctx,
        path: "/api/memory",
        method: "POST",
        body: {
          id: args.id,
          title: args.title,
          content: args.content,
          tags: args.tags ?? [],
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
      };
    },
  );

  const updateTool = tool(
    "memory_update",
    "Update an existing memory entry. Only the fields you pass in `patch` change.",
    {
      id: z.string(),
      patch: z
        .object({
          title: z.string().optional(),
          content: z.string().optional(),
          tags: z.array(z.string()).optional(),
        })
        .describe("Fields to overwrite. Omitted fields are unchanged."),
    },
    async (args) => {
      const row = await daemonFetch({
        ...ctx,
        path: `/api/memory/${encodeURIComponent(args.id)}`,
        method: "PATCH",
        body: args.patch,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
      };
    },
  );

  const forgetTool = tool(
    "memory_forget",
    "Delete a memory entry permanently. Use sparingly — prefer memory_update to fix wrong details rather than forgetting and re-saving.",
    { id: z.string() },
    async (args) => {
      await daemonFetch({
        ...ctx,
        path: `/api/memory/${encodeURIComponent(args.id)}`,
        method: "DELETE",
      });
      return {
        content: [{ type: "text", text: `memory ${args.id} forgotten` }],
      };
    },
  );

  return createSdkMcpServer({
    name: MEMORY_SERVER_NAME,
    tools: writable
      ? [searchTool, getTool, saveTool, updateTool, forgetTool]
      : [searchTool, getTool],
  });
}
