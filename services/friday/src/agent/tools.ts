import {
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { WebClient } from "@slack/web-api";

/**
 * Creates MCP tools that give the agent proactive access to Slack.
 * These are injected into the Agent SDK session via mcpServers config.
 */
export function createSlackTools(client: WebClient) {
  return createSdkMcpServer({
    name: "friday-slack",
    tools: [
      tool(
        "slack_reply",
        "Post a message to a Slack channel or thread. Use this to send status updates, " +
          "progress reports, or intermediate results proactively — without waiting for " +
          "the turn to complete. Each call posts a separate message. When connected to a " +
          "Slack thread, pass thread_ts to reply directly into that thread.",
        {
          text: z.string().describe("The message text to post (supports Slack mrkdwn formatting)"),
          channel_id: z.string().describe("The Slack channel ID to post to"),
          thread_ts: z
            .string()
            .optional()
            .describe(
              "Thread timestamp to reply in a thread. When set, the reply posts as a " +
                "thread reply rather than a new channel message."
            ),
        },
        async (args) => {
          try {
            const res = await client.chat.postMessage({
              channel: args.channel_id,
              text: args.text,
              ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
            });
            return {
              content: [{ type: "text" as const, text: `Message posted. ts=${res.ts}` }],
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            return {
              content: [{ type: "text" as const, text: `Failed to post: ${msg}` }],
              isError: true,
            };
          }
        }
      ),
    ],
  });
}
