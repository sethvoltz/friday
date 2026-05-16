/**
 * Friday Apps MCP server (FRI-78).
 *
 * Orchestrator-only. Tools call back into the daemon's HTTP API so the
 * transactional installer remains the single source of truth.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentType } from "@friday/shared";
import { daemonFetch } from "./http.js";

export const APPS_SERVER_NAME = "friday-apps";

export interface BuildAppsServerOptions {
  callerName: string;
  callerType: AgentType;
  daemonPort: number;
}

export function buildAppsServer(opts: BuildAppsServerOptions) {
  const ctx = {
    port: opts.daemonPort,
    callerName: opts.callerName,
    callerType: opts.callerType,
  };

  return createSdkMcpServer({
    name: APPS_SERVER_NAME,
    tools: [
      tool(
        "app_install",
        "Install a Friday App from a folder. The folder must contain a `manifest.json`. On success, registers the app's agents and schedules and emits an `app_lifecycle: installed` event.",
        {
          path: z
            .string()
            .describe(
              "Absolute path to the app folder (the directory containing manifest.json). Conventionally `~/.friday/apps/<id>/`.",
            ),
          adopt: z
            .boolean()
            .optional()
            .describe(
              "Set true to rebind an existing agent that has the same name but a different (or no) owner. Default false fails fast on name collision.",
            ),
        },
        async (args) => {
          const result = await daemonFetch({
            ...ctx,
            path: "/api/apps",
            method: "POST",
            body: { folderPath: args.path, adopt: args.adopt ?? false },
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        },
      ),
      tool(
        "app_uninstall",
        "Uninstall a Friday App. Archives the app's agents (preserves sessionId), drops its schedules, and removes the registry row. The app folder is renamed by default so reinstall can recover.",
        {
          app: z.string().describe("App id (the manifest's `id` field)."),
          folderDisposition: z
            .enum(["archive", "keep", "delete"])
            .optional()
            .describe(
              "What to do with the on-disk app folder. `archive` (default) renames to `<id>.uninstalled-<ts>/`. `keep` leaves it in place. **`delete` is irreversible** — it removes the folder contents (manifest, state/, .env, mcp/) and cannot be recovered. The agents, schedules, and registry row are preserved per Friday's preserve-over-delete rule; only the folder is destroyed. Use `archive` unless you have an explicit reason.",
            ),
        },
        async (args) => {
          const result = await daemonFetch({
            ...ctx,
            path: `/api/apps/${encodeURIComponent(args.app)}`,
            method: "DELETE",
            body: { folderDisposition: args.folderDisposition ?? "archive" },
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        },
      ),
      tool(
        "app_list",
        "List installed apps with id, name, version, status, and install time.",
        {},
        async () => {
          const rows = await daemonFetch({ ...ctx, path: "/api/apps" });
          return {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          };
        },
      ),
      tool(
        "app_inspect",
        "Read full app details: registry row, parsed manifest, associated agents + schedules + mcp servers, folder path.",
        { app: z.string() },
        async (args) => {
          const row = await daemonFetch({
            ...ctx,
            path: `/api/apps/${encodeURIComponent(args.app)}`,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
          };
        },
      ),
      tool(
        "app_reload",
        "Re-read the manifest from disk and reconcile the DB. No-op when the manifest hasn't changed. Does not archive agents removed from the manifest — use uninstall for that.",
        { app: z.string() },
        async (args) => {
          const result = await daemonFetch({
            ...ctx,
            path: `/api/apps/${encodeURIComponent(args.app)}/reload`,
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
