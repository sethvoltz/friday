/**
 * Friday-mail MCP server. Bridges agent → daemon HTTP for the mail bus.
 * Exposed to all caller types (every agent can send and receive mail).
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { daemonFetch } from "./http.js";

export const MAIL_SERVER_NAME = "friday-mail";

export interface BuildMailServerOptions {
  callerName: string;
  callerType: string;
  daemonPort: number;
}

export function buildMailServer(opts: BuildMailServerOptions) {
  const ctx = {
    port: opts.daemonPort,
    callerName: opts.callerName,
    callerType: opts.callerType,
  };

  return createSdkMcpServer({
    name: MAIL_SERVER_NAME,
    tools: [
      tool(
        "mail_send",
        [
          "Send mail to another agent. Use for asynchronous coordination — the recipient drains its inbox via mail_inbox.",
          "",
          "Priority semantics:",
          "  - `normal` (default): recipient picks this up at the next turn boundary — i.e. after their current turn finishes. Use for non-urgent coordination, status updates, completed work hand-offs.",
          "  - `critical`: recipient picks this up at the next SDK iteration boundary inside their current turn (mid-turn injection). Use sparingly. The orchestrator may use `critical` freely for time-sensitive reroutes; helpers/builders should reserve `critical` for sub-agent-return-style replies to a parent that is mid-turn waiting for your result.",
        ].join("\n"),
        {
          to: z.string().describe("Recipient agent name."),
          body: z.string().describe("Message body. Markdown ok."),
          type: z
            .enum(["message", "notification", "task"])
            .optional()
            .describe("Mail kind. Defaults to message."),
          priority: z
            .enum(["normal", "critical"])
            .optional()
            .describe(
              "Delivery urgency. `normal` (default) drains at the next turn boundary; `critical` drains mid-turn at the next SDK iteration. See tool description for usage guidance.",
            ),
          subject: z
            .string()
            .optional()
            .describe(
              "Optional one-line subject; surfaces in the inbox card.",
            ),
          threadId: z
            .string()
            .optional()
            .describe(
              "Optional thread id. Use to group related back-and-forth — pass the same id on each reply.",
            ),
          meta: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Optional structured metadata."),
        },
        async (args) => {
          const row = (await daemonFetch({
            ...ctx,
            path: "/api/mail/send",
            method: "POST",
            body: {
              fromAgent: opts.callerName,
              toAgent: args.to,
              type: args.type ?? "message",
              priority: args.priority ?? "normal",
              subject: args.subject,
              threadId: args.threadId,
              body: args.body,
              meta: args.meta,
            },
          })) as { id: number };
          return {
            content: [{ type: "text", text: `mail sent (id=${row.id})` }],
          };
        },
      ),
      tool(
        "mail_inbox",
        "List pending mail addressed to you, oldest first.",
        {},
        async () => {
          const rows = await daemonFetch<unknown[]>({
            ...ctx,
            path: `/api/mail/inbox/${encodeURIComponent(opts.callerName)}`,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          };
        },
      ),
      tool(
        "mail_read",
        "Read a mail item in full and mark it as read.",
        {
          id: z.number().int().describe("Mail id from mail_inbox."),
        },
        async (args) => {
          const row = await daemonFetch({
            ...ctx,
            path: `/api/mail/${args.id}/read`,
            method: "POST",
          });
          return {
            content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
          };
        },
      ),
      tool(
        "mail_close",
        "Close a mail item once you've finished acting on it. After this, it no longer appears in mail_inbox.",
        {
          id: z.number().int().describe("Mail id."),
        },
        async (args) => {
          await daemonFetch({
            ...ctx,
            path: `/api/mail/${args.id}/close`,
            method: "POST",
          });
          return {
            content: [{ type: "text", text: `mail ${args.id} closed` }],
          };
        },
      ),
    ],
  });
}
