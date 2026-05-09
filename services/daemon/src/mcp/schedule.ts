/**
 * Friday-schedule MCP server. Cron / one-shot scheduling.
 *
 * Orchestrator only — sub-agents shouldn't be modifying their own
 * schedules, and bare/scheduled have no business creating new ones.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentType } from "@friday/shared";
import { daemonFetch } from "./http.js";

export const SCHEDULE_SERVER_NAME = "friday-schedule";

export interface BuildScheduleServerOptions {
  callerName: string;
  callerType: AgentType;
  daemonPort: number;
}

export function buildScheduleServer(opts: BuildScheduleServerOptions) {
  const ctx = {
    port: opts.daemonPort,
    callerName: opts.callerName,
    callerType: opts.callerType,
  };

  return createSdkMcpServer({
    name: SCHEDULE_SERVER_NAME,
    tools: [
      tool(
        "schedule_upsert",
        "Create or replace a schedule. Provide either `cron` (5-field cron expression) or `runAt` (ISO timestamp for a one-shot run). Re-upserting the same name updates fields in place.",
        {
          name: z
            .string()
            .describe(
              "Unique schedule name. Reuse to update; pick a fresh name for a new schedule.",
            ),
          cron: z
            .string()
            .optional()
            .describe(
              "5-field cron expression, e.g. `0 4 * * *` (daily at 04:00).",
            ),
          runAt: z
            .string()
            .optional()
            .describe(
              "ISO timestamp for a one-shot run. Used instead of `cron`.",
            ),
          taskPrompt: z
            .string()
            .describe(
              "What the scheduled agent should do when it fires. The first-turn prompt for the spawned worker.",
            ),
          paused: z
            .boolean()
            .optional()
            .describe("Start paused. Default false."),
        },
        async (args) => {
          await daemonFetch({
            ...ctx,
            path: "/api/schedules",
            method: "POST",
            body: args,
          });
          return {
            content: [{ type: "text", text: `schedule ${args.name} upserted` }],
          };
        },
      ),
      tool(
        "schedule_list",
        "List all schedules with their cron / runAt / next-run / last-run / paused state.",
        {},
        async () => {
          const rows = await daemonFetch({ ...ctx, path: "/api/schedules" });
          return {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          };
        },
      ),
      tool(
        "schedule_show",
        "Read one schedule.",
        { name: z.string() },
        async (args) => {
          const row = await daemonFetch({
            ...ctx,
            path: `/api/schedules/${encodeURIComponent(args.name)}`,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
          };
        },
      ),
      tool(
        "schedule_pause",
        "Pause a schedule. The cron tick will skip it until resumed.",
        { name: z.string() },
        async (args) => {
          await daemonFetch({
            ...ctx,
            path: `/api/schedules/${encodeURIComponent(args.name)}/pause`,
            method: "POST",
          });
          return {
            content: [{ type: "text", text: `schedule ${args.name} paused` }],
          };
        },
      ),
      tool(
        "schedule_resume",
        "Resume a paused schedule. nextRunAt is recomputed so it doesn't immediately fire.",
        { name: z.string() },
        async (args) => {
          await daemonFetch({
            ...ctx,
            path: `/api/schedules/${encodeURIComponent(args.name)}/resume`,
            method: "POST",
          });
          return {
            content: [{ type: "text", text: `schedule ${args.name} resumed` }],
          };
        },
      ),
      tool(
        "schedule_delete",
        "Delete a schedule permanently. Any in-flight run completes; future fires are cancelled.",
        { name: z.string() },
        async (args) => {
          await daemonFetch({
            ...ctx,
            path: `/api/schedules/${encodeURIComponent(args.name)}`,
            method: "DELETE",
          });
          return {
            content: [{ type: "text", text: `schedule ${args.name} deleted` }],
          };
        },
      ),
      tool(
        "schedule_trigger",
        "Fire a schedule immediately (out-of-band). Returns the runId. nextRunAt is updated as if this were a regular fire.",
        { name: z.string() },
        async (args) => {
          const row = await daemonFetch({
            ...ctx,
            path: `/api/schedules/${encodeURIComponent(args.name)}/trigger`,
            method: "POST",
          });
          return {
            content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
          };
        },
      ),
    ],
  });
}
