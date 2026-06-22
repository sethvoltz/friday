/**
 * Friday-inbox MCP server (FRI-171 / ADR-047). ORCHESTRATOR-ONLY — contrast
 * friday-habit/friday-reminder (every caller) and like friday-schedule /
 * friday-evolve / friday-apps (orchestrator-only).
 *
 * Two tools let the orchestrator read and act on the stateless-intake Inbox
 * when Seth says "work through my inbox":
 *   - inbox_list: read OPEN Inbox items (kind, cleaned text, target, rationale,
 *     age) so the orchestrator can summarize what is waiting.
 *   - inbox_act:  approve / reject / dismiss / triage / undo one item by id,
 *     reusing the SAME daemon-side executor/dispatch path the dashboard uses.
 *
 * These are ORDINARY tools — invoked only at Seth's explicit in-chat direction.
 * There is NO timer, cron, or out-of-band trigger wired to them; triage is
 * Seth's job (build contract §1). Handlers POST/GET the daemon's
 * /api/intake/inbox + /api/intake/act routes (the sole Postgres writer),
 * exactly how friday-habit/friday-schedule reach daemon state.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentType } from "@friday/shared";
import { daemonFetch, signalFrom } from "./http.js";

export const INBOX_SERVER_NAME = "friday-inbox";

export interface BuildInboxServerOptions {
  callerName: string;
  callerType: AgentType;
  daemonPort: number;
}

export function buildInboxServer(opts: BuildInboxServerOptions) {
  const ctx = {
    port: opts.daemonPort,
    callerName: opts.callerName,
    callerType: opts.callerType,
  };
  return createSdkMcpServer({
    name: INBOX_SERVER_NAME,
    tools: [
      tool(
        "inbox_list",
        "List OPEN Inbox items — Captures Seth quick-added that the stateless intake router placed but hasn't fully resolved. Each item has a `kind` ('done' = already executed, FYI with undo; 'proposed' = staged for your approval; 'unsorted' = the router couldn't confidently route it), the cleaned text, the chosen route target (or null when unsorted), the router's one-line rationale, and the item's age. Use this when Seth asks you to work through his inbox; summarize what's waiting and ask before acting unless he told you to act.",
        {},
        async (_args, extra) => {
          const result = await daemonFetch<{ items: unknown[] }>({
            ...ctx,
            signal: signalFrom(extra),
            path: "/api/intake/inbox",
          });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        },
      ),
      tool(
        "inbox_act",
        "Act on one Inbox item by id. `action`: 'approve' runs the staged executor for a Proposed item (creates the reminder/memory/ticket/etc.) and resolves it; 'reject' resolves a Proposed item WITHOUT executing it; 'dismiss' resolves any open item without acting; 'triage' routes an Unsorted item to an agent target (requires `targetId` of the form 'agent:<name>') by mail and resolves it; 'undo' reverses a Done item's executed artifact and resolves it. Only act at Seth's explicit direction. Each action is idempotent: re-acting on an already-resolved item is a safe no-op.",
        {
          id: z.string().describe("The Inbox item id (from inbox_list)."),
          action: z
            .enum(["approve", "reject", "dismiss", "triage", "undo"])
            .describe("What to do with the item."),
          targetId: z
            .string()
            .optional()
            .describe(
              "Required only for action='triage': the agent route target id, e.g. 'agent:friday'.",
            ),
        },
        async (args, extra) => {
          const result = await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            path: "/api/intake/act",
            method: "POST",
            body: { id: args.id, action: args.action, targetId: args.targetId },
          });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        },
      ),
    ],
  });
}
