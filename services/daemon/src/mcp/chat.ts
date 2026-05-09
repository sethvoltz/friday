/**
 * Friday-chat MCP server. The single tool `chat_reply` posts a user-facing
 * message to the dashboard chat. The daemon emits an `agent_message` SSE
 * event tagged with the speaker so the dashboard can render inline.
 *
 * Builders do NOT get this tool (they communicate via mail + PR). Hard gating
 * happens in builder.ts; this module just defines the surface.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { daemonFetch } from "./http.js";

export const CHAT_SERVER_NAME = "friday-chat";

export interface BuildChatServerOptions {
  callerName: string;
  callerType: string;
  daemonPort: number;
}

export function buildChatServer(opts: BuildChatServerOptions) {
  return createSdkMcpServer({
    name: CHAT_SERVER_NAME,
    tools: [
      tool(
        "chat_reply",
        "Post a user-facing message to the dashboard chat. Use to reply to the user; do not dump tool output verbatim.",
        {
          text: z
            .string()
            .describe("Markdown message to display in the chat."),
          kind: z
            .enum(["progress", "final"])
            .optional()
            .describe(
              "Optional intent tag. `progress` for status updates, `final` for the conclusion of the turn.",
            ),
        },
        async (args) => {
          await daemonFetch({
            port: opts.daemonPort,
            callerName: opts.callerName,
            callerType: opts.callerType,
            path: "/api/chat/reply",
            method: "POST",
            body: {
              from: opts.callerName,
              fromType: opts.callerType,
              text: args.text,
              kind: args.kind ?? "progress",
            },
          });
          return {
            content: [{ type: "text", text: "(chat_reply delivered)" }],
          };
        },
      ),
    ],
  });
}
