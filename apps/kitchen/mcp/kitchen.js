#!/usr/bin/env node
// Kitchen App — stdio MCP server entry point.
//
// Spawned by the daemon with cwd = the app folder. All persisted state
// lives under that cwd; see storage.js.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createStorage, KitchenStorageError } from "./storage.js";
import { buildTools } from "./tools.js";

const storage = createStorage(process.cwd());
const tools = buildTools();
const byName = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
  { name: "kitchen-app", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = byName.get(req.params.name);
  if (!tool) {
    throw new Error(`unknown tool: ${req.params.name}`);
  }
  try {
    const result = await tool.handler(req.params.arguments ?? {}, storage);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const code = err instanceof KitchenStorageError ? err.code : "error";
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ code, message }) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
