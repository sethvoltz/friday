/**
 * Friday-integrations MCP server. Cross-system imports and writes (Linear
 * today; future GitHub Issues, Jira, etc.). Exposed to every non-archived
 * agent type so sub-agents can file follow-ups directly.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentType } from "@friday/shared";
import { daemonFetch, signalFrom } from "./http.js";

export const INTEGRATIONS_SERVER_NAME = "friday-integrations";

export interface BuildIntegrationsServerOptions {
  callerName: string;
  callerType: AgentType;
  daemonPort: number;
}

export function buildIntegrationsServer(opts: BuildIntegrationsServerOptions) {
  const ctx = {
    port: opts.daemonPort,
    callerName: opts.callerName,
    callerType: opts.callerType,
  };

  return createSdkMcpServer({
    name: INTEGRATIONS_SERVER_NAME,
    tools: [
      tool(
        "linear_import",
        "Import a Linear issue as a Friday ticket. Idempotent — re-importing the same identifier returns the existing ticket with `alreadyLinked: true`. Requires LINEAR_API_KEY in the daemon env.",
        {
          identifier: z.string().describe("Linear issue identifier, e.g. `FRI-42` or `ENG-123`."),
        },
        async (args, extra) => {
          const result = await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            path: "/api/integrations/linear/import",
            method: "POST",
            body: { identifier: args.identifier },
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        },
      ),
      tool(
        "linear_create_issue",
        "WRITES to Linear: create a new Linear issue. Requires LINEAR_API_KEY. The team is resolved from `team` (key or UUID) if provided, otherwise from the FRIDAY_LINEAR_TEAM env var, then `linear.team` in config; if none of those is set the integration falls back to the first team the API key can see and logs a warning. Optional `priority` accepts a named level — Linear stores priority as 0–4 on the wire; we map the names to ints in the daemon.",
        {
          title: z.string().describe("Issue title (required)."),
          body: z
            .string()
            .optional()
            .describe(
              "Issue description, markdown supported. Maps to Linear's `description` field.",
            ),
          team: z
            .string()
            .optional()
            .describe(
              'Linear team key (e.g. "FRI") or team UUID. Overrides FRIDAY_LINEAR_TEAM and `linear.team` for this call only.',
            ),
          priority: z
            .enum(["none", "urgent", "high", "medium", "low"])
            .optional()
            .describe(
              'Linear issue priority. Maps to Linear\'s 0–4 wire format: "none"=0, "urgent"=1, "high"=2, "medium"=3, "low"=4. Omit to leave unset (Linear defaults to "none").',
            ),
        },
        async (args, extra) => {
          const result = await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            path: "/api/integrations/linear/create-issue",
            method: "POST",
            body: {
              title: args.title,
              body: args.body,
              team: args.team,
              priority: args.priority,
            },
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        },
      ),
      tool(
        "linear_update_issue",
        "WRITES to Linear: update an existing Linear issue identified by `identifier` (e.g. `FRI-75`). Requires LINEAR_API_KEY. Any of `title`, `body`, `state`, `priority` may be supplied; omitted fields are left unchanged. `state` is a Linear state type (`triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`) and resolves to the first workflow state of that type on the issue's team. `priority` is a named level (`none`, `urgent`, `high`, `medium`, `low`) mapped to Linear's 0–4 wire encoding.",
        {
          identifier: z.string().describe("Linear issue identifier, e.g. `FRI-75` (required)."),
          title: z.string().optional().describe("New issue title."),
          body: z
            .string()
            .optional()
            .describe(
              "New issue description, markdown supported. Maps to Linear's `description` field.",
            ),
          state: z
            .enum(["triage", "backlog", "unstarted", "started", "completed", "canceled"])
            .optional()
            .describe(
              "Linear state type to move the issue into. Resolves to the first workflow state of that type on the issue's team.",
            ),
          priority: z
            .enum(["none", "urgent", "high", "medium", "low"])
            .optional()
            .describe(
              'Linear issue priority. Maps to Linear\'s 0–4 wire format: "none"=0, "urgent"=1, "high"=2, "medium"=3, "low"=4.',
            ),
        },
        async (args, extra) => {
          const result = await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            path: "/api/integrations/linear/update-issue",
            method: "POST",
            body: {
              identifier: args.identifier,
              title: args.title,
              body: args.body,
              state: args.state,
              priority: args.priority,
            },
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        },
      ),
      tool(
        "linear_reconcile",
        "Run a Linear reconcile pass on demand: list active Linear issues, cross-reference against existing Friday tickets, and report orphans and stale links. Read-only — does not import.",
        {},
        async (_args, extra) => {
          const result = await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            path: "/api/integrations/linear/reconcile",
            method: "POST",
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        },
      ),
    ],
  });
}
