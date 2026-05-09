/**
 * Friday-tickets MCP server. Trackable work items, persisted in the
 * `tickets` table with separate comment + external-link tables.
 *
 * Available to orchestrator + builder + helper. Bare and scheduled don't
 * touch tickets directly — bares are user explorations; scheduled meta-
 * agents push proposals through evolve, which the orchestrator turns into
 * tickets.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentType } from "@friday/shared";
import { daemonFetch } from "./http.js";

export const TICKETS_SERVER_NAME = "friday-tickets";

export interface BuildTicketsServerOptions {
  callerName: string;
  callerType: AgentType;
  daemonPort: number;
}

const TICKET_STATUS = ["open", "in_progress", "done", "blocked", "closed"] as const;
const TICKET_KIND = ["task", "epic", "bug", "chore"] as const;

export function buildTicketsServer(opts: BuildTicketsServerOptions) {
  const ctx = {
    port: opts.daemonPort,
    callerName: opts.callerName,
    callerType: opts.callerType,
  };

  return createSdkMcpServer({
    name: TICKETS_SERVER_NAME,
    tools: [
      tool(
        "ticket_create",
        "Open a new ticket for trackable work. Use for anything that warrants persistence beyond this conversation — bugs, features, follow-ups, deferred decisions.",
        {
          title: z.string(),
          body: z
            .string()
            .optional()
            .describe("Markdown body. Include acceptance criteria when relevant."),
          status: z.enum(TICKET_STATUS).optional().describe("Default `open`."),
          kind: z.enum(TICKET_KIND).optional().describe("Default `task`."),
          assignee: z
            .string()
            .optional()
            .describe(
              "Agent name or human handle. Leave empty for unassigned.",
            ),
          meta: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Optional structured metadata."),
        },
        async (args) => {
          const row = await daemonFetch({
            ...ctx,
            path: "/api/tickets",
            method: "POST",
            body: args,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
          };
        },
      ),
      tool(
        "ticket_list",
        "List tickets with optional filters.",
        {
          status: z.enum(TICKET_STATUS).optional(),
          assignee: z.string().optional(),
        },
        async (args) => {
          const params = new URLSearchParams();
          if (args.status) params.set("status", args.status);
          if (args.assignee) params.set("assignee", args.assignee);
          const qs = params.toString() ? `?${params.toString()}` : "";
          const rows = await daemonFetch({
            ...ctx,
            path: `/api/tickets${qs}`,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          };
        },
      ),
      tool(
        "ticket_get",
        "Read a ticket including its comments and external links.",
        { id: z.string().describe("Ticket id, e.g. FRI-42.") },
        async (args) => {
          const row = await daemonFetch({
            ...ctx,
            path: `/api/tickets/${encodeURIComponent(args.id)}`,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
          };
        },
      ),
      tool(
        "ticket_update",
        "Update a ticket. Only the fields you pass change.",
        {
          id: z.string(),
          patch: z.object({
            title: z.string().optional(),
            body: z.string().optional(),
            status: z.enum(TICKET_STATUS).optional(),
            kind: z.enum(TICKET_KIND).optional(),
            assignee: z.string().optional(),
            meta: z.record(z.string(), z.unknown()).optional(),
          }),
        },
        async (args) => {
          const row = await daemonFetch({
            ...ctx,
            path: `/api/tickets/${encodeURIComponent(args.id)}`,
            method: "PATCH",
            body: args.patch,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
          };
        },
      ),
      tool(
        "ticket_comment",
        "Add a comment to a ticket. The comment's `author` is the calling agent.",
        {
          id: z.string(),
          body: z.string(),
        },
        async (args) => {
          await daemonFetch({
            ...ctx,
            path: `/api/tickets/${encodeURIComponent(args.id)}/comments`,
            method: "POST",
            body: { author: opts.callerName, body: args.body },
          });
          return {
            content: [{ type: "text", text: `comment added to ${args.id}` }],
          };
        },
      ),
      tool(
        "ticket_link_external",
        "Link a ticket to an external system (Linear, GitHub, etc.). Used by reconcile flows; safe for the orchestrator to call directly when it has authoritative external ids.",
        {
          id: z.string().describe("Friday ticket id."),
          system: z
            .string()
            .describe("External system name, e.g. `linear`, `github`."),
          externalId: z
            .string()
            .describe("System-specific identifier, e.g. `FRI-42` in Linear."),
          url: z.string().optional(),
          meta: z.record(z.string(), z.unknown()).optional(),
        },
        async (args) => {
          await daemonFetch({
            ...ctx,
            path: `/api/tickets/${encodeURIComponent(args.id)}/links`,
            method: "POST",
            body: {
              system: args.system,
              externalId: args.externalId,
              url: args.url,
              meta: args.meta,
            },
          });
          return {
            content: [
              {
                type: "text",
                text: `linked ${args.id} → ${args.system}:${args.externalId}`,
              },
            ],
          };
        },
      ),
    ],
  });
}
