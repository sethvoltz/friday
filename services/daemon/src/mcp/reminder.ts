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
import { loadConfig, reminderDefaultHour } from "@friday/shared";
import { daemonFetch, signalFrom } from "./http.js";

export const REMINDER_SERVER_NAME = "friday-reminder";

export interface BuildReminderServerOptions {
  callerName: string;
  callerType: AgentType;
  daemonPort: number;
  appId?: string;
}

export function buildReminderServer(opts: BuildReminderServerOptions) {
  const ctx = { port: opts.daemonPort, callerName: opts.callerName, callerType: opts.callerType };
  return createSdkMcpServer({
    name: REMINDER_SERVER_NAME,
    tools: [
      tool(
        "reminder_create",
        "Schedule a user-facing reminder that fires at a time as a chat notification WITHOUT waking you or any agent — no turn, no tokens. Use for nudges to the user (e.g. 'thaw the chicken at midday Thursday'). Provide exactly one of `runAt` (ISO timestamp, one-shot), `cron` (5-field, recurring), or `dueDate` (calendar day YYYY-MM-DD). When the user names a DAY without a clock time (e.g. 'remind me Friday', 'thaw the cod Thursday'), pass `dueDate` and do NOT guess a runAt — it fires at the configured default reminder hour (09:00 local).",
        {
          title: z.string().describe("Short reminder text shown to the user."),
          body: z.string().optional().describe("Optional longer detail."),
          runAt: z.string().optional().describe("ISO timestamp for a one-shot reminder."),
          cron: z.string().optional().describe("5-field cron for a recurring reminder."),
          dueDate: z
            .string()
            .optional()
            .describe(
              "Calendar day YYYY-MM-DD with NO clock time; fires at the configured default reminder hour (09:00 local).",
            ),
          targetAgent: z
            .string()
            .optional()
            .describe("Whose chat to deliver into. Defaults to the orchestrator."),
          deepLink: z.string().optional().describe("Optional deep-link back to context."),
          name: z.string().optional().describe("Optional stable name; auto-generated if omitted."),
          idempotencyKey: z
            .string()
            .optional()
            .describe("Stable per-app key for idempotent re-emission; requires an app context."),
        },
        async (args, extra) => {
          // Three-way exactly-one guard over {runAt, cron, dueDate}. Runs
          // before any daemonFetch so a bad call POSTs nothing.
          const provided = [args.runAt, args.cron, args.dueDate].filter(Boolean).length;
          if (provided !== 1) {
            return {
              content: [{ type: "text", text: "Provide exactly one of runAt, cron, or dueDate." }],
              isError: true,
            };
          }
          // APP-NAMESPACE GUARD: an idempotencyKey only makes sense inside an
          // app context (it namespaces the deterministic name); reject it for
          // non-app callers and POST nothing.
          if (args.idempotencyKey && opts.appId === undefined) {
            return {
              content: [{ type: "text", text: "idempotencyKey requires an app context." }],
              isError: true,
            };
          }
          // FRI-168: the `app:<appId>:<key>` name namespace is reserved for app
          // callers. A non-app caller passing such a name could UPDATE-clobber an
          // app's existing reminder (name is the upsert PK). Reject it, POST nothing.
          if (opts.appId === undefined && args.name?.startsWith("app:")) {
            return {
              content: [
                { type: "text", text: "the 'app:' name prefix is reserved for app callers." },
              ],
              isError: true,
            };
          }
          // Resolve dueDate -> a CONCRETE runAt HERE so a one-shot reminder is
          // persisted with a real runAt. scheduler.nextRunAfterFire returns
          // null (one-shot complete-on-fire) only when `r.runAt && !r.cron`; a
          // dueDate row missing a concrete runAt would fail that guard and
          // re-deliver every 30s forever.
          let runAt = args.runAt;
          if (args.dueDate) {
            const [y, mo, d] = args.dueDate.split("-").map(Number);
            const hour = reminderDefaultHour(loadConfig());
            // LOCAL time — do NOT use new Date("YYYY-MM-DD") (parses as UTC).
            const resolved = new Date(y, mo - 1, d, hour, 0, 0, 0);
            runAt = resolved.toISOString();
          }
          const name =
            opts.appId && args.idempotencyKey
              ? `app:${opts.appId}:${args.idempotencyKey}`
              : (args.name ?? `reminder_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
          await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            path: "/api/schedules",
            method: "POST",
            body: {
              name,
              kind: "reminder",
              runAt,
              cron: args.cron,
              appId: opts.appId,
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
      tool(
        "reminder_snooze",
        "Re-arm a fired or pending reminder to fire again after a delay (e.g. '2h', '30m', '1d').",
        { name: z.string(), duration: z.string() },
        async (args, extra) => {
          await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            path: `/api/schedules/${encodeURIComponent(args.name)}/snooze`,
            method: "POST",
            body: { duration: args.duration },
          });
          return {
            content: [{ type: "text", text: `reminder ${args.name} snoozed for ${args.duration}` }],
          };
        },
      ),
    ],
  });
}
