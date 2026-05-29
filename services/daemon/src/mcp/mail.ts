/**
 * Friday-mail MCP server. Bridges agent → daemon HTTP for the mail bus.
 * Exposed to all caller types (every agent can send and receive mail).
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { daemonFetch, signalFrom } from "./http.js";

export const MAIL_SERVER_NAME = "friday-mail";

/**
 * FRI-127 §3: name the return-path obligation BEFORE the priority-semantics
 * paragraph. The prior wording described the mechanism ("Send mail … for
 * asynchronous coordination") but never told a Helper/Builder that mailing
 * the parent back is REQUIRED when a delegated task finishes — that obligation
 * lived only in the agent prompts, a weak signal. Leading with the obligation
 * closes the loop's second failure mode (child completes silently). Exported
 * so the contract can be asserted without booting the MCP server.
 */
export const MAIL_SEND_DESCRIPTION = [
  "Send mail to another agent — including back to your parent. REQUIRED when you finish a delegated task: when your parent spawned you with agent_create, your final action must be mail_send to that parent with the result. Without it, your parent never learns you're done.",
  "",
  "Priority semantics:",
  "  - `normal` (default): recipient picks this up at the next turn boundary — i.e. after their current turn finishes. Use for non-urgent coordination, status updates, completed work hand-offs.",
  "  - `critical`: recipient picks this up at the next SDK iteration boundary inside their current turn (mid-turn injection). Use sparingly. The orchestrator may use `critical` freely for time-sensitive reroutes; helpers/builders should reserve `critical` for sub-agent-return-style replies to a parent that is mid-turn waiting for your result.",
].join("\n");

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
        MAIL_SEND_DESCRIPTION,
        {
          to: z
            .string()
            .describe(
              "Recipient agent name. Must be a literal registered agent name, or the symbolic `parent` (your spawner) or `self`. Role names like `orchestrator` / `builder` / `helper` are rejected.",
            ),
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
            .describe("Optional one-line subject; surfaces in the inbox card."),
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
        async (args, extra) => {
          const row = (await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
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
        async (_args, extra) => {
          const rows = await daemonFetch<unknown[]>({
            ...ctx,
            signal: signalFrom(extra),
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
        async (args, extra) => {
          const row = await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
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
        async (args, extra) => {
          await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
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
