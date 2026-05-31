#!/usr/bin/env node
// Minimal stdio MCP server exposing a single `ping` tool. Used by the
// Friday Apps platform tests to verify per-app MCP wiring; never published.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// FRI-36: derive the app folder from FRIDAY_APP_DIR (injected by the daemon),
// with an import.meta.url walk as defense-in-depth. Never trust process.cwd()
// from inside an app MCP server — the SDK drops any cwd we set, so the
// spawned process inherits the daemon's cwd.
const APP_DIR = process.env.FRIDAY_APP_DIR ?? dirname(dirname(fileURLToPath(import.meta.url)));

const server = new Server(
  { name: "example-echo", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ping",
      description: "Echo back a string. Used to verify per-app MCP wiring.",
      inputSchema: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "ping") {
    throw new Error(`unknown tool: ${req.params.name}`);
  }
  const msg = req.params.arguments?.msg ?? `pong from ${APP_DIR}`;
  return { content: [{ type: "text", text: String(msg) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
