import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { RuntimeConfig } from "../config.js";
import { sendToAgent, type AgentCallbacks } from "../agent/client.js";
import { resetSession, getSessionId } from "../sessions/manager.js";
import {
  getSessionStats,
  formatDuration,
  formatAge,
} from "../monitor/session-stats.js";
import {
  enqueue,
  drain,
  isProcessing,
  finishProcessing,
  updateQueued,
  removeQueued,
  swapToProcessing,
  clearProcessingEmoji,
  type QueuedMessage,
} from "../sessions/queue.js";

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
    } else if (args === "session") {
      const sessionId = getSessionId(channelId);
      if (!sessionId) {
        await client.chat.postMessage({
          channel: channelId,
          text: "No active session",
          blocks: [
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: ":information_source:  No active session for this channel",
                },
              ],
            },
          ],
        });
        return;
      }

      const stats = getSessionStats(sessionId);
      const workDir = config.agent.workingDirectory;

      const fields = [
        `*Session*  \`${sessionId.slice(0, 8)}…\``,
        `*Turns*  ${stats?.turnCount ?? "—"}`,
        `*Cost*  ${stats ? `$${stats.totalCostUsd.toFixed(4)}` : "—"}`,
        `*Cache hit rate*  ${stats ? `${stats.cacheHitRate}%` : "—"}`,
        `*Started*  ${stats ? formatAge(stats.firstTurnAt) : "—"}`,
        `*Agent time*  ${stats ? formatDuration(stats.totalDurationMs) : "—"}`,
        `*Working dir*  \`${workDir}\``,
      ];

      await client.chat.postMessage({
        channel: channelId,
        text: `Session ${sessionId.slice(0, 8)}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: fields.join("  ·  "),
            },
          },
        ],
      });
    } else if (args === "" || args === "help") {
      await respond(
        "*Friday commands:*\n" +
          "• `/friday reset` — Clear session, start fresh\n" +
          "• `/friday session` — Show current session info\n" +
          "• `/friday help` — Show this message"
      );
    } else {
      await respond(`Unknown command: \`${args}\`. Try \`/friday help\`.`);
    }
  });

  // Handle message edits — update queued content if still waiting
  app.event("message", async ({ event, client }) => {
    if (
      event.subtype === "message_changed" &&
      "message" in event &&
      "previous_message" in event
    ) {
      const changed = event as any;
      const channelId = changed.channel;
      const messageTs = changed.message?.ts;
      const newText = changed.message?.text;

      if (messageTs && newText && updateQueued(channelId, messageTs, newText)) {
        console.log(
          JSON.stringify({
            event: "queued_message_edited",
            channelId,
            messageTs,
          })
        );
      }
    }

    if (event.subtype === "message_deleted" && "previous_message" in event) {
      const deleted = event as any;
      const channelId = deleted.channel;
      const messageTs = deleted.previous_message?.ts;

      if (messageTs && removeQueued(channelId, messageTs)) {
        // Remove the queued emoji from the deleted message
        try {
          await client.reactions.remove({
            channel: channelId,
            timestamp: messageTs,
            name: emojis.queued,
          });
        } catch {
          // Message already deleted, reaction gone
        }
        console.log(
          JSON.stringify({
            event: "queued_message_deleted",
            channelId,
            messageTs,
          })
        );
      }
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
    const userId = message.user;

    const queuedMsg: QueuedMessage = {
      id: ts,
      channelId,
      text,
      userId,
      wasQueued: isProcessing(channelId),
    };

    if (queuedMsg.wasQueued) {
      // Agent is busy — queue with 🕐
      enqueue(queuedMsg);
      try {
        await client.reactions.add({
          channel: channelId,
          timestamp: ts,
          name: emojis.queued,
        });
      } catch {
        // Ignore
      }
      return;
    }

    // Not busy — process immediately
    enqueue(queuedMsg);
    await processQueue(channelId, isOrchestrator, config, client, say);
  });

  async function processQueue(
    channelId: string,
    isOrchestrator: boolean,
    config: RuntimeConfig,
    client: WebClient,
    say: (msg: { text: string; thread_ts?: string }) => Promise<any>
  ): Promise<void> {
    const maxLen = config.slack_formatting.maxMessageLength;
    const streamingEnabled = config.slack_formatting.streamingEnabled;

    while (true) {
      const batch = drain(channelId);
      if (!batch || batch.length === 0) {
        finishProcessing(channelId);
        return;
      }

      // Only echo the user's message when it was queued (out of order)
      const wasQueued = batch.some((m) => m.wasQueued);

      // Swap queued emoji → processing emoji for queued messages,
      // add processing emoji directly for non-queued messages
      if (wasQueued) {
        await swapToProcessing(
          client,
          batch,
          emojis.queued,
          emojis.processing
        );
      } else {
        // Add :eyes: directly for linear (non-queued) messages
        for (const msg of batch) {
          try {
            await client.reactions.add({
              channel: msg.channelId,
              timestamp: msg.id,
              name: emojis.processing,
            });
          } catch {
            // Ignore
          }
        }
      }

      // Combine batch into single prompt
      const prompt =
        batch.length === 1
          ? batch[0].text
          : batch.map((m) => m.text).join("\n\n");

      const quoted = wasQueued
        ? batch
            .map((m) =>
              m.text
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n")
            )
            .join("\n\n")
        : null;

      // For queued messages: post placeholder with blockquote echo + "Working..."
      // For linear messages: no placeholder needed, :eyes: emoji is sufficient
      let placeholderTs: string | null = null;
      if (quoted) {
        const placeholderRes = await client.chat.postMessage({
          channel: channelId,
          text: `${quoted}\n\n_Working..._`,
        });
        placeholderTs = placeholderRes.ts!;
      }

      try {
        const agentOptions = {
          channelId,
          isOrchestrator,
          workingDirectory: config.agent.workingDirectory,
          allowedTools: isOrchestrator
            ? config.agent.allowedTools
            : config.independentAgent?.allowedTools ?? [
                "Read",
                "Glob",
                "Grep",
              ],
          model: config.agent.model,
        };

        // Compaction status message — posted on start, updated on end
        let compactMsgTs: string | null = null;
        const compactionCallbacks: AgentCallbacks = {
          onCompactStart: () => {
            client.chat
              .postMessage({
                channel: channelId,
                text: ":hourglass_flowing_sand: _Compacting conversation..._",
              })
              .then((res) => {
                compactMsgTs = res.ts ?? null;
              })
              .catch(() => {});
          },
          onCompactEnd: (result) => {
            const text =
              result === "success"
                ? ":clamp: _Conversation was compacted_"
                : ":warning: _Compaction failed_";
            if (compactMsgTs) {
              client.chat
                .update({ channel: channelId, ts: compactMsgTs, text })
                .catch(() => {});
            } else {
              client.chat
                .postMessage({ channel: channelId, text })
                .catch(() => {});
            }
          },
        };

        if (streamingEnabled) {
          // For streaming without a placeholder, post an initial message
          let streamTs = placeholderTs;
          if (!streamTs) {
            const initRes = await client.chat.postMessage({
              channel: channelId,
              text: "_..._",
            });
            streamTs = initRes.ts!;
          }
          await processWithStreaming(
            prompt,
            quoted,
            channelId,
            agentOptions,
            client,
            say,
            streamTs,
            maxLen,
            compactionCallbacks
          );
        } else {
          const response = await sendToAgent(
            prompt,
            agentOptions,
            compactionCallbacks
          );
          const chunks = chunkMessage(response, maxLen);

          if (placeholderTs) {
            await client.chat.update({
              channel: channelId,
              ts: placeholderTs,
              text: chunks[0],
            });
          } else {
            await say({ text: chunks[0] });
          }
          for (let i = 1; i < chunks.length; i++) {
            await say({ text: chunks[i] });
          }
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Unknown error";
        console.error("Agent error:", errorMessage);

        if (placeholderTs) {
          await client.chat.update({
            channel: channelId,
            ts: placeholderTs,
            text: quoted
              ? `${quoted}\n\n:radioactive_sign: _${errorMessage}_`
              : `:radioactive_sign: _${errorMessage}_`,
          }).catch(() => {});
        } else {
          await say({
            text: `:radioactive_sign: _${errorMessage}_`,
          });
        }

        // Error emoji on the last message in the batch
        const lastMsg = batch[batch.length - 1];
        try {
          await client.reactions.add({
            channel: channelId,
            timestamp: lastMsg.id,
            name: "radioactive_sign",
          });
        } catch {
          // Ignore
        }
      } finally {
        // Clear processing emoji from all batch messages
        await clearProcessingEmoji(client, batch, emojis.processing);
      }

      // Loop to check if more messages arrived while we were processing
    }
  }

  async function processWithStreaming(
    prompt: string,
    quoted: string | null,
    channelId: string,
    agentOptions: Parameters<typeof sendToAgent>[1],
    client: WebClient,
    say: (msg: { text: string; thread_ts?: string }) => Promise<any>,
    placeholderTs: string,
    maxLen: number,
    extraCallbacks?: AgentCallbacks
  ): Promise<void> {
    let accumulated = "";
    let lastUpdateTime = 0;
    const UPDATE_INTERVAL_MS = 1000; // Throttle edits to 1/sec
    const quotedLen = quoted ? quoted.length + 10 : 0; // +10 for "\n\n" padding

    const response = await sendToAgent(
      prompt,
      agentOptions,
      {
        ...extraCallbacks,
        onChunk: (chunk: string) => {
        accumulated += chunk;

        const now = Date.now();
        if (now - lastUpdateTime < UPDATE_INTERVAL_MS) return;
        lastUpdateTime = now;

        const responsePreview =
          accumulated.length > maxLen - quotedLen - 50
            ? accumulated.slice(0, maxLen - quotedLen - 50) +
              "\n\n_...streaming..._"
            : accumulated + "\n\n_..._";

        const updateText = quoted
          ? `${quoted}\n\n${responsePreview}`
          : responsePreview;

        client.chat
          .update({
            channel: channelId,
            ts: placeholderTs,
            text: updateText,
          })
          .catch(() => {});
        },
      }
    );

    // Final update: replace placeholder with final content
    const chunks = chunkMessage(response, maxLen);

    await client.chat.update({
      channel: channelId,
      ts: placeholderTs,
      text: chunks[0],
    });
    // Post any overflow chunks as new messages
    for (let i = 1; i < chunks.length; i++) {
      await say({ text: chunks[i] });
    }
  }
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
