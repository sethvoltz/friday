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
import { killAgentByName, getAgentStallState } from "../agent/lifecycle.js";
import { getRecentlyTouchedFiles } from "../monitor/file-tracker.js";
import { buildInspectResult, formatTurns } from "@friday/shared";
import {
  getSessionStats,
  formatDuration,
  formatAge,
} from "../monitor/session-stats.js";
import {
  enqueue,
  drain,
  isProcessing as isSlackInnerProcessing,
  finishProcessing,
  updateQueued,
  removeQueued,
  swapToProcessing,
  clearProcessingEmoji,
  addStatusReaction,
  removeStatusReaction,
  swapStatusReaction,
  type QueuedMessage,
} from "../sessions/queue.js";
import {
  enqueueTurn,
  isProcessing as isTurnProcessing,
} from "../sessions/turn-queue.js";
import {
  buildSystemPrompt,
  chunkMessage,
  buildBatchContent,
  buildBlockquote,
  formatErrorResponse,
  buildSessionFields,
  isInterruptSignal,
  type MultimodalPrompt,
} from "./helpers.js";
import { fetchSlackImages } from "./image-fetch.js";
import { createMemoryTools } from "../memory/memory-tools.js";
import { buildMemoryContext } from "../memory/auto-recall.js";
import { createScheduleTools } from "../scheduler/schedule-tools.js";
import { createEvolveTools } from "../evolve/evolve-tools.js";
import { buildLinearMcpServer } from "../linear/mcp.js";
import { LINEAR_MCP_NAME } from "../linear/constants.js";
import { logFeedback } from "./feedback.js";
import { getByThread, touchActivity, setPendingReaction } from "./thread-registry.js";
import { createThreadTools } from "./thread-tools.js";
import { mailSend } from "../comms/mail.js";
import { getSkillRegistry } from "../skills/registry.js";

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

      const now = Date.now();
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
        const linearTicket =
          "linearTicket" in entry && entry.linearTicket
            ? `  ·  Linear: \`${entry.linearTicket}\``
            : "";

        // Last-activity label
        const stall = getAgentStallState(name);
        const lastChunkAge = stall ? Math.round((now - stall.lastChunkAt) / 1000) : null;
        const activityStr = lastChunkAge !== null ? `  ·  _${lastChunkAge}s ago_` : "";

        // Stall indicator (only for active agents with stall state)
        const STALL_THRESHOLD_DISPLAY = 30_000;
        const isStalled =
          stall !== null &&
          entry.status === "active" &&
          !stall.toolCallActive &&
          !stall.waitingForMail &&
          now - stall.lastChunkAt > STALL_THRESHOLD_DISPLAY;
        const stallIndicator = isStalled ? "  :warning: *stall*" : "";

        const status = entry.status === "active" ? ":large_green_circle:" : ":white_circle:";
        return `${status} ${typeLabel}  *${name}*  \`${entry.type}\`${parent}${workspace}${linearTicket}${activityStr}${stallIndicator}`;
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
    } else if (args.startsWith("kill")) {
      const agentName = args.replace(/^kill\s*/, "").trim();
      if (!agentName) {
        await respond("Usage: `/friday kill <agent-name>`");
        return;
      }
      if (agentName === "orchestrator") {
        await respond(":no_entry:  Cannot kill the Orchestrator.");
        return;
      }
      const killEntry = getAgent(agentName);
      if (!killEntry) {
        await respond(
          `:x:  Agent \`${agentName}\` not found. Use \`/friday agents\` to see available agents.`
        );
        return;
      }
      try {
        killAgentByName(agentName);

        // Report recently touched files so the user knows what was in-flight
        const touched = getRecentlyTouchedFiles(agentName, 1);
        const touchedFiles =
          touched.length > 0 && touched[0].files.length > 0
            ? `\nFiles touched in the killed turn: ${touched[0].files.join(", ")}`
            : "";

        await client.chat.postEphemeral({
          channel: channelId,
          user: command.user_id,
          text: `:skull:  Agent *${agentName}* killed. Workspace preserved.${touchedFiles}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text:
                  `:skull:  Agent *${agentName}* killed. Workspace preserved.` +
                  (touchedFiles ? `\n${touchedFiles}` : ""),
              },
            },
          ],
        });
      } catch (err) {
        await respond(
          `:x:  Failed to kill \`${agentName}\`: ${err instanceof Error ? err.message : String(err)}`
        );
      }
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
          "• `/friday agents` — List active agents (with stall indicators)\n" +
          "• `/friday kill <agent>` — Force-kill a running agent (workspace preserved)\n" +
          "• `/friday inspect <agent>` — Inspect agent's recent transcript\n" +
          "• `/friday help` — Show this message\n" +
          "\n" +
          "*Skills:*\n" +
          "• `@friday /skill-name [args]` — Invoke a skill directly by name (e.g. `@friday /review`, `@friday /grill-me`)"
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

      if (messageTs && newText) {
        const previousText = changed.previous_message?.text;
        if (updateQueued(channelId, messageTs, newText)) {
          log("info", "queued_message_edited", { channelId, messageTs });
        }
        // Always log feedback — edits to already-processed messages are signal too.
        logFeedback({
          kind: "edited",
          channelId,
          messageTs,
          previousText,
          newText,
        });
      }
    }

    if (event.subtype === "message_deleted" && "previous_message" in event) {
      const deleted = event as any;
      const channelId = deleted.channel;
      const messageTs = deleted.previous_message?.ts;
      const previousText = deleted.previous_message?.text;

      if (messageTs) {
        if (removeQueued(channelId, messageTs)) {
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
        logFeedback({
          kind: "deleted",
          channelId,
          messageTs,
          previousText,
        });
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

    // Thread message routing: if this is a reply inside a connected thread,
    // forward it directly to the connected agent and skip the orchestrator queue.
    const msgThreadTs = rawMsg.thread_ts as string | undefined;
    if (msgThreadTs && msgThreadTs !== ts) {
      const threadConn = getByThread(msgThreadTs);
      if (threadConn) {
        mailSend({
          from: "orchestrator",
          to: threadConn.agentName,
          subject: `[thread] ${text}`,
          body: text,
        });
        touchActivity(threadConn.agentName);
        await client.reactions.add({ channel: channelId, timestamp: ts, name: emojis.processing }).catch(() => {});
        setPendingReaction(threadConn.agentName, channelId, ts, emojis.processing);
        return;
      }
      // Thread not connected — fall through to normal processing
    }

    // Fetch image attachments (non-image files and download failures are skipped)
    const images = hasFiles
      ? await fetchSlackImages(rawMsg.files, config.slackBotToken)
      : undefined;

    // wasQueued (UI affordance — :clock: emoji) reflects whether ANY turn
    // is in flight or queued for this channel, including a mail turn.
    // slackInFlight tells us whether processQueue is mid drain-loop right
    // now; if so, the new message will be picked up by the in-flight
    // drain and we don't need to enqueue a fresh slack trigger.
    const wasQueued = isTurnProcessing(channelId);
    const slackInFlight = isSlackInnerProcessing(channelId);

    const queuedMsg: QueuedMessage = {
      id: ts,
      channelId,
      text,
      userId,
      wasQueued,
      images: images && images.length > 0 ? images : undefined,
      interrupt: sessionType === "orchestrator" && isInterruptSignal(text),
      threadTs: msgThreadTs && msgThreadTs !== ts ? msgThreadTs : undefined,
    };

    // Explicit skill invocation: "@friday /skill-name [args]"
    // Strip any leading Slack mention (e.g. <@U0ABC123>) and check for /skill-name
    const strippedText = text.replace(/^<@[A-Z0-9]+>\s*/i, "").trim();
    const skillInvoke = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(strippedText);
    if (skillInvoke) {
      const skillName = skillInvoke[1].toLowerCase();
      const skillArgs = skillInvoke[2]?.trim() ?? "";
      const registry = getSkillRegistry();
      const skill = registry?.getByName(skillName);
      if (skill) {
        const currentScopeMatches =
          skill.scope.length === 0 || skill.scope.includes(sessionType as any);

        if (!currentScopeMatches) {
          // Skill is not meant for orchestrator — try routing to an active scoped agent
          const scopeTypes = new Set(skill.scope);
          const target = listAgents().find(
            ({ entry }) =>
              entry.status === "active" &&
              scopeTypes.has(entry.type as any)
          );
          if (target) {
            const body = skillArgs
              ? `${skill.body}\n\n${skillArgs}`
              : skill.body;
            mailSend({
              from: "orchestrator",
              to: target.name,
              subject: `[skill] /${skillName}`,
              body,
            });
            log("info", "skill_dispatched_to_agent", {
              skill: skillName,
              agent: target.name,
            });
            await client.chat.postMessage({
              channel: channelId,
              text: `Dispatching \`/${skillName}\` to *${target.name}*…`,
            });
            return;
          }
          // No matching active agent — fall through and run locally anyway
        }

        // Run the skill locally: inject body into the queued message
        queuedMsg.skillBody = skill.body;
        queuedMsg.text = skillArgs;
        log("info", "skill_invoked_locally", { skill: skillName, channelId });
      }
    }

    enqueue(queuedMsg);

    if (wasQueued) {
      try {
        await client.reactions.add({
          channel: channelId,
          timestamp: ts,
          name: emojis.queued,
        });
      } catch {
        // Ignore
      }
    }

    if (!slackInFlight) {
      enqueueTurn({
        channelId,
        source: "slack",
        label: ts,
        run: () => processQueue(channelId, sessionType, config, client, say),
      });
    }
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
      // Current tool reaction emoji on the last batch message
      let currentToolEmoji: string | null = null;
      // Every status emoji we've ever attempted to add — finally drains them all
      // so a late callback can't leave a stuck reaction.
      const statusEmojisAttempted = new Set<string>();
      // Set true at the start of finally; further callbacks are no-ops after this.
      let processingDone = false;

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
          mcpServers: (() => {
            const linear = buildLinearMcpServer();
            const baseOrch = {
              "friday-slack": slackMcp,
              "friday-agents": agentMcp,
              "friday-mail": createMailTools({ callerName: "orchestrator" }),
              "friday-memory": createMemoryTools({ callerName: "orchestrator" }),
              "friday-scheduler": createScheduleTools({
                model: config.agent.model,
                defaultCwd: config.agent.workingDirectory,
              }),
              "friday-evolve": createEvolveTools({ callerName: "orchestrator" }),
              "friday-threads": createThreadTools(client),
            };
            const baseBare = {
              "friday-memory": createMemoryTools({ callerName: `bare-${channelId}` }),
            };
            const base = isOrchestrator ? baseOrch : baseBare;
            return linear ? { ...base, [LINEAR_MCP_NAME]: linear } : base;
          })(),
          systemPrompt: buildSystemPrompt(
            config,
            sessionType,
            channelId,
            config.agent.workingDirectory
          ),
        };

        // Capture for closures — TS loses the !null narrowing inside nested fns.
        const batchMsgs = batch;

        // Helpers that gate on processingDone and remember every emoji we attempt
        // to add, so the finally cleanup can drain everything (including late
        // callbacks) without leaving stuck reactions.
        function trackedAdd(emoji: string): void {
          if (processingDone || !emoji) return;
          statusEmojisAttempted.add(emoji);
          addStatusReaction(client, batchMsgs, emoji).catch(() => {});
        }
        function trackedRemove(emoji: string): void {
          if (!emoji) return;
          removeStatusReaction(client, batchMsgs, emoji).catch(() => {});
        }

        // Thinking indicator — posted when agent takes too long, deleted on first content
        // Also adds a 🤔 reaction on the last batch message alongside the text message.
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
            trackedAdd(emojis.thinking);
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
            trackedRemove(emojis.thinking);
          },
        };

        // Tool use reactions — swap emoji on the last batch message as tools fire.
        // MCP tools come through as `mcp__<server>__<tool>` and currently land in
        // the generic bucket; a finer-grained mail/memory/scheduler split is a
        // pending UX call (would need new EmojiConfig fields).
        function toolEmojiFor(toolName: string): string {
          const codingTools = new Set(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);
          const webTools = new Set(["WebFetch", "WebSearch"]);
          if (codingTools.has(toolName)) return emojis.toolCoding;
          if (webTools.has(toolName) || toolName.toLowerCase().includes("browser")) return emojis.toolWeb;
          return emojis.toolGeneric;
        }

        // Compaction — ✍ reaction on start; on end remove the reaction and, if
        // the compaction failed, surface that explicitly so the user isn't left
        // wondering why the next turn looks weird.
        const agentCallbacks: AgentCallbacks = {
          ...thinkingCallbacks,
          onToolUse: (toolName) => {
            if (processingDone) return;
            const newEmoji = toolEmojiFor(toolName);
            // No-op if the same bucket; spares the API a remove+add round-trip
            // (e.g. five consecutive Reads = one add, not ten swaps).
            if (newEmoji === currentToolEmoji) return;
            const previous = currentToolEmoji;
            currentToolEmoji = newEmoji;
            statusEmojisAttempted.add(newEmoji);
            swapStatusReaction(client, batchMsgs, previous, newEmoji).catch(() => {});
          },
          onCompactStart: () => {
            trackedAdd(emojis.compacting);
          },
          onCompactEnd: (result) => {
            trackedRemove(emojis.compacting);
            if (result === "failed") {
              client.chat
                .postMessage({
                  channel: channelId,
                  text: ":warning: _Compaction failed_",
                })
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
        // Gate further callback adds — late tool_progress events shouldn't add
        // reactions after we've started cleaning up.
        processingDone = true;
        await clearProcessingEmoji(client, batch, emojis.processing);
        // Remove every emoji we ever asked to add — covers the standard
        // thinking/compacting paths plus any tool-bucket emojis swapped in.
        for (const emoji of statusEmojisAttempted) {
          await removeStatusReaction(client, batch, emoji).catch(() => {});
        }
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
