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

/**
 * Catch tool-call serialization mishaps where the SDK harness folded a
 * parameter's XML wrapper into a sibling string. Seen in the wild: the model
 * emitted a `tags` value without its `<parameter name="tags">…</parameter>`
 * wrapper, so the literal text `</content>\n<tags>["..."]</tags>\n</invoke>`
 * landed in `content`. The lenient parser persisted that as a real memory
 * body. We reject those calls so the model gets immediate, visible feedback
 * instead of silently corrupting the store.
 *
 * Returns null when the value is clean; returns a human-readable rejection
 * message when it isn't.
 */
export function validateMemoryField(
  fieldName: string,
  value: string,
): string | null {
  if (value.includes("</invoke>")) {
    return `${fieldName} contains the literal string \`</invoke>\` — this is a tool-call serialization error. Re-issue the call with each parameter wrapped in its own \`<parameter name="...">\` block. \`tags\` in particular must be a separate array parameter, not appended to \`content\`.`;
  }
  const tail = value.slice(-200);
  if (/<\/(content|tags|parameter|title)>\s*$/i.test(tail)) {
    return `${fieldName} ends with a parameter-closing token (e.g. \`</content>\`, \`</tags>\`). That's almost always a tool-call serialization error where a sibling parameter got merged into this field. Re-issue the call with each parameter in its own wrapper.`;
  }
  return null;
}

function rejectionResult(reason: string) {
  return {
    content: [{ type: "text" as const, text: `memory tool rejected: ${reason}` }],
    isError: true,
  };
}

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
    "Search Friday's persistent memory for relevant entries. Returns matches ranked by FTS relevance with a recall-frequency boost (title +3, content +1, exact tag +5). Use this BEFORE saving to avoid creating near-duplicates. Returns title, id, score, and matchedOn; use memory_get for full content.",
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
    "Read a memory entry in full by its id. Bumps the entry's recall counter so the FTS ranker learns which memories are useful in practice. Use when a search result's snippet isn't enough and you need the full body.",
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
    "Save a new memory entry. Memories persist across sessions and conversations and surface automatically in the next turn's `<memory-context>` block. Use for decisions, user preferences, project context, lessons learned, external-system pointers — anything worth remembering long-term. **Search first to avoid duplicates** — if a memory on the same topic exists, use `memory_update` to refine it instead. Tag every entry with its type (`user` / `feedback` / `project` / `reference`) plus topical tags; tags weight +5 in the FTS ranker. **Do not use the built-in Memory tool** — Friday's `autoMemoryEnabled` is disabled and the SDK's project-scoped memory directory is not Friday's store.",
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
      const titleErr = validateMemoryField("title", args.title);
      if (titleErr) return rejectionResult(titleErr);
      const contentErr = validateMemoryField("content", args.content);
      if (contentErr) return rejectionResult(contentErr);
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
    "Update an existing memory entry in place. Preserves recall history and creation metadata. Use this to correct or extend a memory instead of forgetting and re-creating it. Only the fields you pass in `patch` change.",
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
      if (args.patch.title !== undefined) {
        const err = validateMemoryField("patch.title", args.patch.title);
        if (err) return rejectionResult(err);
      }
      if (args.patch.content !== undefined) {
        const err = validateMemoryField("patch.content", args.patch.content);
        if (err) return rejectionResult(err);
      }
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
    "Delete a memory entry permanently. Use when a memory is outdated, contradicted by reality, or no longer relevant. Prefer `memory_update` to correct wrong details rather than forgetting and re-saving — update preserves recall history.",
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
