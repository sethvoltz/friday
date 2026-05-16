#!/usr/bin/env node
// Minimal stdio MCP server exposing a single `ping` tool. Used by the
// Friday Apps platform tests to verify per-app MCP wiring; never published.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

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
  const msg = req.params.arguments?.msg ?? "pong";
  return { content: [{ type: "text", text: String(msg) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
