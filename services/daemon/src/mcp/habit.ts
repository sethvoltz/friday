/**
 * Friday-habit MCP server. CORE habit/streak tracker (FRI-169) reachable by
 * ALL caller types — contrast friday-schedule (orchestrator-only). Every app
 * sub-agent + the orchestrator can add, check off, and read Habits, so this is
 * a core in-process server registered unconditionally in builder.ts, exactly
 * how friday-reminder reaches every caller.
 *
 * Glossary (CONTEXT.md `### Habits`): a Habit is a tracked recurring
 * commitment; a Check-in is one timestamped completion; a Streak is the run of
 * consecutive Satisfied periods, derived on read against now() and never
 * stored. Handlers POST/GET/PATCH/DELETE the daemon's /api/habits* routes (the
 * sole Postgres writer), which compute the Streak on read and converge with
 * the dashboard's Zero-mutator check-off on the same habit_checkins rows.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentType } from "@friday/shared";
import { daemonFetch, signalFrom } from "./http.js";

export const HABIT_SERVER_NAME = "friday-habit";

export interface BuildHabitServerOptions {
  callerName: string;
  callerType: AgentType;
  daemonPort: number;
  /**
   * FRI-168 trap: appId is threaded via this EXPLICIT options object, never by
   * widening the shared ctx — that would leak appId into mail/memory/tickets.
   * Present only when the caller agent belongs to an installed app. Reserved
   * for future per-app habit namespacing; not yet consulted by the handlers.
   */
  appId?: string;
}

export function buildHabitServer(opts: BuildHabitServerOptions) {
  const ctx = { port: opts.daemonPort, callerName: opts.callerName, callerType: opts.callerType };
  return createSdkMcpServer({
    name: HABIT_SERVER_NAME,
    tools: [
      tool(
        "habit_add",
        "Create a Habit — a recurring thing the user intends to do and checks off (e.g. 'brush teeth', 'run a 5K', 'write 20 blog posts/month'). `period` is the recurrence window the Target is measured over (day|week|month|year); `target` is how many Check-ins satisfy one Period (default 1). `mode` is 'ongoing' (open-ended) or 'bounded' (has a window). Only create Habits the user actually asked you to track — do not invent Habits on the user's behalf.",
        {
          name: z.string().describe("Short Habit name shown to the user (e.g. 'brush teeth')."),
          mode: z
            .enum(["ongoing", "bounded"])
            .describe(
              "'ongoing' (open-ended) or 'bounded' (has a window with windowStart/windowEnd).",
            ),
          period: z
            .enum(["day", "week", "month", "year"])
            .describe("The recurrence window the Target is measured over."),
          target: z
            .number()
            .int()
            .optional()
            .describe("Check-ins required to satisfy one Period (default 1)."),
          description: z.string().optional().describe("Optional longer detail."),
          daysOfWeek: z
            .number()
            .int()
            .optional()
            .describe(
              "Weekday bitmask (Sun=bit0 … Sat=bit6) constraining a day-Period to specific weekdays (e.g. Mon/Wed/Fri). Only meaningful when period='day'.",
            ),
          bucket: z
            .enum(["morning", "afternoon", "evening", "anytime"])
            .optional()
            .describe("Optional Time-of-day bucket for grouping today's Habits in the UI."),
          colorIndex: z
            .number()
            .int()
            .optional()
            .describe("Habit color index 1-7 into the active Palette's habit ramp."),
          windowStart: z
            .string()
            .optional()
            .describe("ISO timestamp; start of a bounded Habit's window."),
          windowEnd: z
            .string()
            .optional()
            .describe("ISO timestamp; end of a bounded Habit's window."),
        },
        async (args, extra) => {
          const habit = await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            path: "/api/habits",
            method: "POST",
            body: {
              name: args.name,
              mode: args.mode,
              period: args.period,
              target: args.target,
              description: args.description,
              daysOfWeek: args.daysOfWeek,
              bucket: args.bucket,
              colorIndex: args.colorIndex,
              windowStart: args.windowStart,
              windowEnd: args.windowEnd,
            },
          });
          return { content: [{ type: "text", text: JSON.stringify(habit, null, 2) }] };
        },
      ),
      tool(
        "habit_checkin",
        "Log a Check-in — one timestamped completion of a Habit. Pass the Habit id (use habit_list / habit_status to find it). `ts` optionally backdates the Check-in (ISO timestamp; defaults to now). This is append-only and high-frequency. IMPORTANT: only check in Habits you are responsible for — do not check off a Habit on the user's behalf unless the user told you they did it, and do not check in another agent's or the user's personal Habits speculatively.",
        {
          habit: z.string().describe("The Habit id to log a Check-in against."),
          ts: z
            .string()
            .optional()
            .describe("ISO timestamp to backdate the Check-in; defaults to now."),
          note: z.string().optional().describe("Optional note recorded with the Check-in."),
        },
        async (args, extra) => {
          const checkin = await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            path: `/api/habits/${encodeURIComponent(args.habit)}/checkin`,
            method: "POST",
            body: { ts: args.ts, note: args.note },
          });
          return { content: [{ type: "text", text: JSON.stringify(checkin, null, 2) }] };
        },
      ),
      tool(
        "habit_list",
        "List Habits with each one's live Streak and current-Period progress. Pass filter='active' (default) for tracked Habits or filter='archived' for retired ones.",
        {
          filter: z
            .enum(["active", "archived"])
            .optional()
            .describe("'active' (default) or 'archived'."),
        },
        async (args, extra) => {
          const habits = await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            path: `/api/habits?filter=${args.filter ?? "active"}`,
          });
          return { content: [{ type: "text", text: JSON.stringify(habits, null, 2) }] };
        },
      ),
      tool(
        "habit_status",
        "Read one Habit by id — its live Streak, current-Period progress, and recent Check-ins. Use this to check another agent's or the user's Habit before deciding whether to act.",
        { habit: z.string().describe("The Habit id to read.") },
        async (args, extra) => {
          const habit = await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            path: `/api/habits/${encodeURIComponent(args.habit)}`,
          });
          return { content: [{ type: "text", text: JSON.stringify(habit, null, 2) }] };
        },
      ),
      tool(
        "habit_update",
        "Update a Habit's definition (name, target, period, bucket, color, window, etc.). Pass the Habit id plus only the fields to change. Only update Habits the user asked you to change.",
        {
          habit: z.string().describe("The Habit id to update."),
          name: z.string().optional().describe("New Habit name."),
          description: z.string().optional().describe("New description."),
          mode: z.enum(["ongoing", "bounded"]).optional().describe("New Habit mode."),
          period: z
            .enum(["day", "week", "month", "year"])
            .optional()
            .describe("New recurrence Period."),
          target: z.number().int().optional().describe("New Target per Period."),
          daysOfWeek: z
            .number()
            .int()
            .nullable()
            .optional()
            .describe("New weekday bitmask (or null to clear); only meaningful when period='day'."),
          bucket: z
            .enum(["morning", "afternoon", "evening", "anytime"])
            .optional()
            .describe("New Time-of-day bucket."),
          colorIndex: z.number().int().optional().describe("New Habit color index 1-7."),
          windowStart: z
            .string()
            .nullable()
            .optional()
            .describe("New bounded-window start (ISO) or null to clear."),
          windowEnd: z
            .string()
            .nullable()
            .optional()
            .describe("New bounded-window end (ISO) or null to clear."),
        },
        async (args, extra) => {
          const { habit, ...patch } = args;
          const updated = await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            path: `/api/habits/${encodeURIComponent(habit)}`,
            method: "PATCH",
            body: patch,
          });
          return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
        },
      ),
      tool(
        "habit_archive",
        "Archive a Habit by id (status='archived'). Preserves all data — the Habit and its Check-ins are kept, never deleted. Use this to retire a Habit instead of deleting it.",
        { habit: z.string().describe("The Habit id to archive.") },
        async (args, extra) => {
          const archived = await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            path: `/api/habits/${encodeURIComponent(args.habit)}/archive`,
            method: "POST",
          });
          return { content: [{ type: "text", text: JSON.stringify(archived, null, 2) }] };
        },
      ),
      tool(
        "habit_checkin_undo",
        "Delete exactly one Check-in by its id (the single allowed delete — undoes a mistaken Check-in). Sibling Check-ins for the same Habit are left intact. Only undo a Check-in you or the user logged in error.",
        { checkinId: z.string().describe("The Check-in id to delete.") },
        async (args, extra) => {
          await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            path: `/api/habits/checkin/${encodeURIComponent(args.checkinId)}`,
            method: "DELETE",
          });
          return { content: [{ type: "text", text: `check-in ${args.checkinId} undone` }] };
        },
      ),
    ],
  });
}
