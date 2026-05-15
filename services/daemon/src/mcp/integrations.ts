/**
 * Friday-integrations MCP server. Cross-system imports (Linear today;
 * future GitHub Issues, Jira, etc.). Orchestrator only — sub-agents
 * shouldn't be reaching out to external services on their own.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentType } from "@friday/shared";
import { daemonFetch } from "./http.js";

export const INTEGRATIONS_SERVER_NAME = "friday-integrations";

export interface BuildIntegrationsServerOptions {
  callerName: string;
  callerType: AgentType;
  daemonPort: number;
}

export function buildIntegrationsServer(
  opts: BuildIntegrationsServerOptions,
) {
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
          identifier: z
            .string()
            .describe("Linear issue identifier, e.g. `FRI-42` or `ENG-123`."),
        },
        async (args) => {
          const result = await daemonFetch({
            ...ctx,
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
        "WRITES to Linear: create a new Linear issue. Requires LINEAR_API_KEY. The team is resolved from `team` (key or UUID) if provided, otherwise from the FRIDAY_LINEAR_TEAM env var, then `linear.team` in config; if none of those is set the integration falls back to the first team the API key can see and logs a warning.",
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
        },
        async (args) => {
          const result = await daemonFetch({
            ...ctx,
            path: "/api/integrations/linear/create-issue",
            method: "POST",
            body: { title: args.title, body: args.body, team: args.team },
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
        async () => {
          const result = await daemonFetch({
            ...ctx,
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
