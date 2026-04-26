import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { RuntimeConfig } from "../config.js";
import { sendToAgent, type AgentCallbacks } from "../agent/client.js";
import { createSlackTools } from "../agent/tools.js";
import { createAgentTools } from "../agent/agent-tools.js";
import { createMailTools } from "../comms/mail-tools.js";
import { log } from "../log.js";
import { resetSession, getSessionId } from "../sessions/manager.js";
import { listAgents, getAgent } from "../sessions/registry.js";
import { buildInspectResult, formatTurns } from "@friday/shared";
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
import {
  buildSystemPrompt,
  chunkMessage,
  buildBatchContent,
  buildBlockquote,
  formatErrorResponse,
  buildSessionFields,
  type MultimodalPrompt,
} from "./helpers.js";
import { fetchSlackImages } from "./image-fetch.js";
import { createMemoryTools } from "../memory/memory-tools.js";
import { buildMemoryContext } from "../memory/auto-recall.js";

export function registerEventHandlers(app: App, config: RuntimeConfig): void {
  const orchestratorChannelId = config.slack.orchestratorChannelId;
  const emojis = config.slack_formatting.emojiReactions;

  // /friday slash command — top-level command namespace
  app.command("/friday", async ({ command, ack, respond, client }) => {
    await ack();
    const args = command.text.trim().toLowerCase();
    const channelId = command.channel_id;

    if (args === "reset") {
      // Block reset on orchestrator channel — it's long-lived
      if (channelId === orchestratorChannelId) {
        await respond(
          "The Orchestrator session is long-lived and can't be reset. " +
            "If you really need to start fresh, stop the daemon and clear the session manually."
        );
        return;
      }

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
    } else if (args === "agents") {
      const agents = listAgents().filter(({ entry }) => entry.status !== "destroyed");
      if (agents.length === 0) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: command.user_id,
          text: "No active agents",
          blocks: [
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: ":information_source:  No active agents",
                },
              ],
            },
          ],
        });
        return;
      }

      const lines = agents.map(({ name, entry }) => {
        const typeLabel =
          entry.type === "orchestrator"
            ? ":crown:"
            : entry.type === "builder"
              ? ":hammer:"
              : ":zap:";
        const workspace =
          "workspace" in entry ? `  ·  \`${entry.workspace}\`` : "";
        const parent =
          "parent" in entry ? `  ·  _parent: ${entry.parent}_` : "";
        const status = entry.status === "active" ? ":large_green_circle:" : ":white_circle:";
        return `${status} ${typeLabel}  *${name}*  \`${entry.type}\`${parent}${workspace}`;
      });

      await client.chat.postEphemeral({
        channel: channelId,
        user: command.user_id,
        text: `Active agents: ${agents.length}`,
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: `Active Agents (${agents.length})`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: lines.join("\n"),
            },
          },
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
      const fields = buildSessionFields(
        sessionId,
        stats,
        workDir,
        formatAge,
        formatDuration
      );

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
    } else if (args.startsWith("inspect")) {
      const agentName = args.replace(/^inspect\s*/, "").trim();
      if (!agentName) {
        await respond("Usage: `/friday inspect <agent-name>`");
        return;
      }

      const entry = getAgent(agentName);
      if (!entry) {
        await respond(`Agent \`${agentName}\` not found. Use \`/friday agents\` to see available agents.`);
        return;
      }

      try {
        const cwdOverride = entry.type === "orchestrator" ? config.agent.workingDirectory : undefined;
        const result = await buildInspectResult(agentName, entry, {
          lastN: 3,
          includeTools: true,
          cwdOverride,
        });

        const stats = entry.sessionId ? getSessionStats(entry.sessionId) : null;

        const fields = [
          `*${agentName}*  \`${entry.type}\``,
          `Status: ${entry.status === "active" ? ":large_green_circle:" : ":white_circle:"} ${entry.status}`,
          ...("parent" in entry ? [`Parent: ${entry.parent}`] : []),
          ...(stats ? [`Turns: ${stats.turnCount}`, `Cost: $${stats.totalCostUsd.toFixed(4)}`] : []),
        ].join("  ·  ");

        const blocks: any[] = [
          { type: "section", text: { type: "mrkdwn", text: fields } },
        ];

        if (result.turns.length > 0) {
          blocks.push({ type: "divider" });
          const turnSummaries = result.turns.map((t) => {
            const prompt = t.prompt.length > 100 ? t.prompt.slice(0, 100) + "…" : t.prompt;
            const response = t.response.length > 200 ? t.response.slice(0, 200) + "…" : t.response;
            const tools = t.toolCalls.length > 0
              ? `\n_Tools: ${t.toolCalls.map((tc) => `\`${tc.name}\``).join(", ")}_`
              : "";
            return `*Turn ${t.index + 1}*\n> ${prompt}\n${response}${tools}`;
          });
          blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: turnSummaries.join("\n\n") },
          });
        } else {
          blocks.push({
            type: "context",
            elements: [{ type: "mrkdwn", text: "_No turns in transcript yet_" }],
          });
        }

        await client.chat.postEphemeral({
          channel: channelId,
          user: command.user_id,
          text: `Inspect: ${agentName}`,
          blocks,
        });
      } catch (err) {
        await respond(`:x: Error inspecting agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (args === "" || args === "help") {
      await respond(
        "*Friday commands:*\n" +
          "• `/friday reset` — Clear session, start fresh\n" +
          "• `/friday session` — Show current session info\n" +
          "• `/friday agents` — List active agents\n" +
          "• `/friday inspect <agent>` — Inspect agent's recent transcript\n" +
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
        log("info", "queued_message_edited", { channelId, messageTs });
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
        log("info", "queued_message_deleted", { channelId, messageTs });
      }
    }
  });

  app.message(async ({ message, client, say }) => {
    // Ignore bot messages, message edits, etc. — but allow file_share (image uploads)
    if (message.subtype && message.subtype !== "file_share") return;
    if (!("user" in message)) return;

    const rawMsg = message as any;
    const hasFiles = Array.isArray(rawMsg.files) && rawMsg.files.length > 0;
    const hasText = "text" in message && !!message.text;

    // Drop messages with neither text nor files
    if (!hasText && !hasFiles) return;

    const channelId = message.channel;
    const sessionType = channelId === orchestratorChannelId ? "orchestrator" as const : "bare" as const;
    const text = hasText ? (message as any).text as string : "";
    const ts = message.ts;
    const userId = message.user as string;

    // Fetch image attachments (non-image files and download failures are skipped)
    const images = hasFiles
      ? await fetchSlackImages(rawMsg.files, config.slackBotToken)
      : undefined;

    const queuedMsg: QueuedMessage = {
      id: ts,
      channelId,
      text,
      userId,
      wasQueued: isProcessing(channelId),
      images: images && images.length > 0 ? images : undefined,
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
    await processQueue(channelId, sessionType, config, client, say);
  });

  async function processQueue(
    channelId: string,
    sessionType: "orchestrator" | "bare",
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

      // Combine batch into single prompt (multimodal when images present)
      const rawPrompt = buildBatchContent(batch);

      // Auto-recall: inject relevant memories into the prompt
      const promptText = typeof rawPrompt === "string" ? rawPrompt : rawPrompt.text;
      const memoryContext = buildMemoryContext(promptText);
      let prompt: string | MultimodalPrompt;
      if (memoryContext) {
        if (typeof rawPrompt === "string") {
          prompt = `${memoryContext}\n\n${rawPrompt}`;
        } else {
          prompt = { ...rawPrompt, text: `${memoryContext}\n\n${rawPrompt.text}` };
        }
      } else {
        prompt = rawPrompt;
      }

      const quoted = wasQueued
        ? buildBlockquote(batch.map((m) => m.text.trim() || "[image]"))
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

      // Thinking indicator message — declared outside try so catch can clean up
      let thinkingMsgTs: string | null = null;

      try {
        const isOrchestrator = sessionType === "orchestrator";
        const slackMcp = createSlackTools(client);
        const agentMcp = createAgentTools({
          callerName: "orchestrator",
          callerType: "orchestrator",
          workingDirectory: config.agent.workingDirectory,
          model: config.agent.model,
          postToSlack: async (text: string) => {
            await client.chat.postMessage({ channel: channelId, text });
          },
          slackChannelId: channelId,
        });
        const agentOptions = {
          channelId,
          sessionType,
          workingDirectory: config.agent.workingDirectory,
          allowedTools: isOrchestrator
            ? config.agent.allowedTools
            : config.independentAgent?.allowedTools ?? [
                "Read",
                "Glob",
                "Grep",
              ],
          model: config.agent.model,
          thinkingIndicatorDelaySec:
            config.slack_formatting.thinkingIndicatorDelaySec,
          mcpServers: isOrchestrator
            ? {
                "friday-slack": slackMcp,
                "friday-agents": agentMcp,
                "friday-mail": createMailTools({ callerName: "orchestrator" }),
                "friday-memory": createMemoryTools({ callerName: "orchestrator" }),
              }
            : {
                "friday-memory": createMemoryTools({ callerName: `bare-${channelId}` }),
              },
          systemPrompt: buildSystemPrompt(
            config,
            sessionType,
            channelId,
            config.agent.workingDirectory
          ),
        };

        // Thinking indicator — posted when agent takes too long, deleted on first content
        const thinkingCallbacks: AgentCallbacks = {
          onThinkingStart: (elapsedSec) => {
            client.chat
              .postMessage({
                channel: channelId,
                text: `_Still thinking... (${elapsedSec}s)_`,
              })
              .then((res) => {
                thinkingMsgTs = res.ts ?? null;
              })
              .catch(() => {});
          },
          onThinkingTick: (elapsedSec) => {
            if (thinkingMsgTs) {
              client.chat
                .update({
                  channel: channelId,
                  ts: thinkingMsgTs,
                  text: `_Still thinking... (${elapsedSec}s)_`,
                })
                .catch(() => {});
            }
          },
          onThinkingEnd: () => {
            if (thinkingMsgTs) {
              client.chat
                .delete({ channel: channelId, ts: thinkingMsgTs })
                .catch(() => {});
              thinkingMsgTs = null;
            }
          },
        };

        // Compaction status message — posted on start, updated on end
        let compactMsgTs: string | null = null;
        const agentCallbacks: AgentCallbacks = {
          ...thinkingCallbacks,
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
            agentCallbacks
          );
        } else {
          const response = await sendToAgent(
            prompt,
            agentOptions,
            agentCallbacks
          );

          if (response) {
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
          } else if (placeholderTs) {
            // Remove placeholder if agent produced no text
            await client.chat.delete({ channel: channelId, ts: placeholderTs }).catch(() => {});
          }
        }
      } catch (err) {
        // Clean up thinking indicator on error (belt-and-suspenders — sendToAgent's
        // finally block handles the normal case, but this covers edge cases)
        if (thinkingMsgTs) {
          client.chat
            .delete({ channel: channelId, ts: thinkingMsgTs })
            .catch(() => {});
          thinkingMsgTs = null;
        }

        const errorMessage =
          err instanceof Error ? err.message : "Unknown error";
        log("error", "agent_error", { channelId, error: errorMessage });

        if (placeholderTs) {
          await client.chat.update({
            channel: channelId,
            ts: placeholderTs,
            text: formatErrorResponse(errorMessage, quoted),
          }).catch(() => {});
        } else {
          await say({
            text: formatErrorResponse(errorMessage, null),
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
    prompt: string | MultimodalPrompt,
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
    if (response) {
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
    } else {
      // Remove placeholder if agent produced no text
      await client.chat.delete({ channel: channelId, ts: placeholderTs }).catch(() => {});
    }
  }
}
