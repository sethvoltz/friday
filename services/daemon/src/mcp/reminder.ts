/**
 * Friday-reminder MCP server. User-facing scheduled reminders that fire as a
 * chat notification WITHOUT waking any agent — no turn, no tokens.
 *
 * Reachable by ALL caller types (contrast friday-schedule, which is
 * orchestrator-only): an app sub-agent (e.g. the kitchen agent) must be able
 * to nudge the user. Reminders are stored as kind='reminder' rows in the
 * shared `schedules` table and delivered via deliverReminder on fire.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentType } from "@friday/shared";
import { daemonFetch, signalFrom } from "./http.js";

export const REMINDER_SERVER_NAME = "friday-reminder";

export interface BuildReminderServerOptions {
  callerName: string;
  callerType: AgentType;
  daemonPort: number;
}

export function buildReminderServer(opts: BuildReminderServerOptions) {
  const ctx = { port: opts.daemonPort, callerName: opts.callerName, callerType: opts.callerType };
  return createSdkMcpServer({
    name: REMINDER_SERVER_NAME,
    tools: [
      tool(
        "reminder_create",
        "Schedule a user-facing reminder that fires at a time as a chat notification WITHOUT waking you or any agent — no turn, no tokens. Use for nudges to the user (e.g. 'thaw the chicken at midday Thursday'). Provide exactly one of `runAt` (ISO timestamp, one-shot) or `cron` (5-field, recurring).",
        {
          title: z.string().describe("Short reminder text shown to the user."),
          body: z.string().optional().describe("Optional longer detail."),
          runAt: z.string().optional().describe("ISO timestamp for a one-shot reminder."),
          cron: z.string().optional().describe("5-field cron for a recurring reminder."),
          targetAgent: z
            .string()
            .optional()
            .describe("Whose chat to deliver into. Defaults to the orchestrator."),
          deepLink: z.string().optional().describe("Optional deep-link back to context."),
          name: z.string().optional().describe("Optional stable name; auto-generated if omitted."),
        },
        async (args, extra) => {
          if (!!args.runAt === !!args.cron) {
            return {
              content: [{ type: "text", text: "Provide exactly one of runAt or cron." }],
              isError: true,
            };
          }
          const name =
            args.name ?? `reminder_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            path: "/api/schedules",
            method: "POST",
            body: {
              name,
              kind: "reminder",
              runAt: args.runAt,
              cron: args.cron,
              taskPrompt: args.title,
              deliveryJson: {
                channel: "chat",
                targetAgent: args.targetAgent,
                title: args.title,
                body: args.body,
                deepLink: args.deepLink,
                originatingAgent: opts.callerName,
              },
            },
          });
          return { content: [{ type: "text", text: `reminder ${name} created` }] };
        },
      ),
      tool("reminder_list", "List all pending reminders.", {}, async (_args, extra) => {
        const rows = await daemonFetch({
          ...ctx,
          signal: signalFrom(extra),
          path: "/api/schedules",
        });
        const reminders = Array.isArray(rows) ? rows.filter((r) => r?.kind === "reminder") : rows;
        return { content: [{ type: "text", text: JSON.stringify(reminders, null, 2) }] };
      }),
      tool(
        "reminder_cancel",
        "Cancel a pending reminder by name.",
        { name: z.string() },
        async (args, extra) => {
          await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            path: `/api/schedules/${encodeURIComponent(args.name)}`,
            method: "DELETE",
          });
          return { content: [{ type: "text", text: `reminder ${args.name} cancelled` }] };
        },
      ),
    ],
  });
}
