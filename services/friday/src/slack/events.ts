import type { App } from "@slack/bolt";
import type { RuntimeConfig } from "../config.js";
import { sendToAgent } from "../agent/client.js";
import { resetSession, getSessionId } from "../sessions/manager.js";

export function registerEventHandlers(app: App, config: RuntimeConfig): void {
  const orchestratorChannelId = config.slack.orchestratorChannelId;
  const emojis = config.slack_formatting.emojiReactions;

  // /friday slash command — top-level command namespace
  app.command("/friday", async ({ command, ack, respond, client }) => {
    await ack();
    const args = command.text.trim().toLowerCase();
    const channelId = command.channel_id;

    if (args === "reset") {
      const hadSession = !!getSessionId(channelId);
      resetSession(channelId);
      await client.chat.postMessage({
        channel: channelId,
        text: hadSession
          ? "Session reset. Next message starts a fresh conversation."
          : "No active session for this channel.",
        blocks: [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: hadSession
                  ? ":recycle:  *Session reset* — next message starts a fresh conversation"
                  : ":shrug:  No active session for this channel",
              },
            ],
          },
          ...(hadSession
            ? [
                {
                  type: "divider" as const,
                },
              ]
            : []),
        ],
      });
    } else if (args === "" || args === "help") {
      await respond(
        "*Friday commands:*\n" +
          "• `/friday reset` — Clear session, start fresh\n" +
          "• `/friday help` — Show this message"
      );
    } else {
      await respond(`Unknown command: \`${args}\`. Try \`/friday help\`.`);
    }
  });

  app.message(async ({ message, client, say }) => {
    // Ignore bot messages, message edits, etc.
    if (message.subtype) return;
    if (!("text" in message) || !message.text) return;
    if (!("user" in message)) return;

    const channelId = message.channel;
    const isOrchestrator = channelId === orchestratorChannelId;
    const text = message.text;
    const ts = message.ts;

    // React with 👀 to acknowledge
    try {
      await client.reactions.add({
        channel: channelId,
        timestamp: ts,
        name: emojis.processing,
      });
    } catch {
      // Reaction may fail if already added — ignore
    }

    try {
      const response = await sendToAgent(text, {
        channelId,
        isOrchestrator,
        workingDirectory: config.agent.workingDirectory,
        allowedTools: isOrchestrator
          ? config.agent.allowedTools
          : config.independentAgent?.allowedTools ?? ["Read", "Glob", "Grep"],
        model: config.agent.model,
      });

      // Chunk response if needed
      const chunks = chunkMessage(
        response,
        config.slack_formatting.maxMessageLength
      );
      for (const chunk of chunks) {
        await say({ text: chunk });
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Unknown error";
      console.error("Agent error:", errorMessage);

      try {
        await client.reactions.add({
          channel: channelId,
          timestamp: ts,
          name: "radioactive_sign",
        });
      } catch {
        // Ignore reaction errors
      }

      await say({ text: `Error: ${errorMessage}`, thread_ts: ts });
    } finally {
      // Remove the processing reaction
      try {
        await client.reactions.remove({
          channel: channelId,
          timestamp: ts,
          name: emojis.processing,
        });
      } catch {
        // Ignore if already removed
      }
    }
  });
}

function chunkMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to break at a newline
    let breakPoint = remaining.lastIndexOf("\n", maxLength);
    if (breakPoint <= 0) {
      // Fall back to space
      breakPoint = remaining.lastIndexOf(" ", maxLength);
    }
    if (breakPoint <= 0) {
      // Hard break
      breakPoint = maxLength;
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}
