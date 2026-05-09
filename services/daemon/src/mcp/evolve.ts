/**
 * Friday-evolve MCP server. Self-improvement proposals.
 *
 * Orchestrator only — sub-agents shouldn't be applying or dismissing
 * proposals. The scheduled meta-agent (Phase E.2 once scan/enrich land)
 * is the canonical writer; this surface lets the orchestrator review,
 * apply, or dismiss.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentType } from "@friday/shared";
import { daemonFetch } from "./http.js";

export const EVOLVE_SERVER_NAME = "friday-evolve";

export interface BuildEvolveServerOptions {
  callerName: string;
  callerType: AgentType;
  daemonPort: number;
}

const PROPOSAL_TYPES = ["memory", "prompt", "config", "code"] as const;
const BLAST_RADIUS = ["low", "medium", "high"] as const;
const PROPOSAL_STATUSES = [
  "open",
  "critical",
  "approved",
  "rejected",
  "applied",
  "superseded",
] as const;

export function buildEvolveServer(opts: BuildEvolveServerOptions) {
  const ctx = {
    port: opts.daemonPort,
    callerName: opts.callerName,
    callerType: opts.callerType,
  };

  return createSdkMcpServer({
    name: EVOLVE_SERVER_NAME,
    tools: [
      tool(
        "evolve_list",
        "List Friday self-improvement proposals.",
        {
          status: z.enum(PROPOSAL_STATUSES).optional(),
          type: z.enum(PROPOSAL_TYPES).optional(),
        },
        async (args) => {
          const params = new URLSearchParams();
          if (args.status) params.set("status", args.status);
          if (args.type) params.set("type", args.type);
          const qs = params.toString() ? `?${params.toString()}` : "";
          const rows = await daemonFetch({
            ...ctx,
            path: `/api/evolve/proposals${qs}`,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          };
        },
      ),
      tool(
        "evolve_get",
        "Read a single proposal in full, including its signals.",
        { id: z.string() },
        async (args) => {
          const row = await daemonFetch({
            ...ctx,
            path: `/api/evolve/proposals/${encodeURIComponent(args.id)}`,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
          };
        },
      ),
      tool(
        "evolve_save",
        "Manually save a new proposal. Use when you've identified an improvement worth tracking outside the automated scan pipeline. Returns the created proposal with its assigned id.",
        {
          title: z.string(),
          type: z.enum(PROPOSAL_TYPES),
          proposedChange: z
            .string()
            .describe("Markdown body — rationale + concrete proposed change."),
          blastRadius: z.enum(BLAST_RADIUS).optional(),
          appliesTo: z
            .array(z.string())
            .optional()
            .describe(
              "What this proposal would touch, e.g. ['agent.systemPrompt', 'config.json'].",
            ),
          score: z.number().min(0).max(100).optional(),
        },
        async (args) => {
          const row = await daemonFetch({
            ...ctx,
            path: "/api/evolve/proposals",
            method: "POST",
            body: args,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
          };
        },
      ),
      tool(
        "evolve_update",
        "Update a proposal's status, score, or other fields.",
        {
          id: z.string(),
          patch: z.object({
            title: z.string().optional(),
            status: z.enum(PROPOSAL_STATUSES).optional(),
            score: z.number().min(0).max(100).optional(),
            proposedChange: z.string().optional(),
            blastRadius: z.enum(BLAST_RADIUS).optional(),
            appliesTo: z.array(z.string()).optional(),
          }),
        },
        async (args) => {
          const row = await daemonFetch({
            ...ctx,
            path: `/api/evolve/proposals/${encodeURIComponent(args.id)}`,
            method: "PATCH",
            body: args.patch,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
          };
        },
      ),
      tool(
        "evolve_apply",
        "Mark a proposal `applied` and create a linked ticket capturing the work. The proposal becomes immutable from this point; future similar issues should produce a fresh proposal.",
        {
          id: z.string(),
          ticketKind: z
            .enum(["task", "epic", "bug", "chore"])
            .optional()
            .describe("Ticket kind. Defaults to `task`."),
          assignee: z
            .string()
            .optional()
            .describe("Optional assignee for the resulting ticket."),
        },
        async (args) => {
          const row = await daemonFetch({
            ...ctx,
            path: `/api/evolve/proposals/${encodeURIComponent(args.id)}/apply`,
            method: "POST",
            body: { ticketKind: args.ticketKind, assignee: args.assignee },
          });
          return {
            content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
          };
        },
      ),
      tool(
        "evolve_dismiss",
        "Dismiss a proposal as not worth pursuing. Sets status to `rejected`. Use when the proposal is misguided or already obsolete.",
        {
          id: z.string(),
          reason: z
            .string()
            .optional()
            .describe(
              "Optional rejection rationale; appended to the proposal body for future scans to learn from.",
            ),
        },
        async (args) => {
          const row = await daemonFetch({
            ...ctx,
            path: `/api/evolve/proposals/${encodeURIComponent(args.id)}/dismiss`,
            method: "POST",
            body: { reason: args.reason },
          });
          return {
            content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
          };
        },
      ),
      tool(
        "evolve_scan",
        "Walk the daemon log + usage table + Claude transcripts and emit fresh proposals from any signals not already covered. Returns a summary of new + merged + promoted-to-critical proposals plus an audit run record.",
        {
          windowHours: z
            .number()
            .min(1)
            .max(24 * 30)
            .optional()
            .describe(
              "Look-back window in hours. Default 24 (the daily meta-agent's pass).",
            ),
        },
        async (args) => {
          const result = await daemonFetch({
            ...ctx,
            path: "/api/evolve/scan",
            method: "POST",
            body: { windowHours: args.windowHours },
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        },
      ),
      tool(
        "evolve_enrich",
        "Run Sonnet over open/critical proposals to replace templated bodies with root-cause analysis + a concrete suggested change. Idempotent: skips proposals already enriched unless `force: true`.",
        {
          id: z
            .string()
            .optional()
            .describe(
              "Enrich only this proposal id. Mutually exclusive with `retryFailed`.",
            ),
          retryFailed: z
            .boolean()
            .optional()
            .describe(
              "Enrich only proposals that have a recorded lastEnrichError.",
            ),
          force: z
            .boolean()
            .optional()
            .describe(
              "Re-enrich even if `enrichedAt` is fresh. Use sparingly.",
            ),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Max proposals enriched per run. Default 50."),
        },
        async (args) => {
          const result = await daemonFetch({
            ...ctx,
            path: "/api/evolve/enrich",
            method: "POST",
            body: args,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        },
      ),
      tool(
        "evolve_cluster",
        "Group near-duplicate open/critical proposals by Jaccard overlap of their signal-hash sets. Each component becomes (or refreshes) a cluster file at `~/.friday/evolve/clusters/<id>.md`; member proposals get their `clusterId` stamped.",
        {
          threshold: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe(
              "Jaccard overlap threshold above which two proposals merge. Default 0.5.",
            ),
        },
        async (args) => {
          const result = await daemonFetch({
            ...ctx,
            path: "/api/evolve/cluster",
            method: "POST",
            body: { threshold: args.threshold },
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        },
      ),
    ],
  });
}
