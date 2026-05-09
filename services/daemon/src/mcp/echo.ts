/**
 * Sanity-check MCP server. Confirms the worker → Claude SDK → MCP plumbing is
 * alive end-to-end. Replaced by real servers (mail, chat, agents, …) in later
 * phases; the echo entry will be dropped once those land.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const ECHO_SERVER_NAME = "friday-echo";

export function buildEchoServer() {
  return createSdkMcpServer({
    name: ECHO_SERVER_NAME,
    tools: [
      tool(
        "echo",
        "Echo the input back unchanged. Use to confirm Friday's MCP plumbing is wired.",
        { message: z.string().describe("Text to echo back.") },
        async (args) => ({
          content: [{ type: "text", text: args.message }],
        }),
      ),
    ],
  });
}
