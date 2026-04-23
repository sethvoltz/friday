# Friday Architecture

## System Overview

Friday is a local-first Slack-to-Claude-Code bridge that lets you command an AI orchestrator agent from anywhere via Slack. Messages flow from Slack through a local daemon to Claude Code sessions running on your machine.

```
Slack (Socket Mode WS) → Friday Daemon → Claude Agent SDK → Claude Code CLI → Anthropic API
```

The daemon is a Node.js process that maintains a persistent WebSocket to Slack and manages Claude Code sessions. It is designed as a well-behaved Unix daemon that any process manager can wrap.

## Core Components

### Bridge Daemon (`services/friday`)

The primary service. Connects to Slack via Socket Mode, routes messages to Agent SDK sessions, and posts responses back.

**Entrypoint:** `src/index.ts` — loads config, creates Slack app, registers event handlers, sets up graceful shutdown.

**Key modules:**

| Module | Responsibility |
|--------|---------------|
| `src/config.ts` | Loads `~/.friday/config.json` + `~/.friday/.env`, validates required fields, merges with defaults |
| `src/log.ts` | Structured JSON logger — all output goes through this (`ts`, `level`, `event`, context fields) |
| `src/slack/app.ts` | Creates `@slack/bolt` App with Socket Mode, global error handler |
| `src/slack/events.ts` | Message handler, `/friday` commands, per-channel FIFO queue, streaming, compaction detection |
| `src/agent/client.ts` | Wraps Agent SDK `query()`, streams text chunks, detects compaction, logs usage, passes MCP servers and system prompt |
| `src/agent/tools.ts` | MCP tool definitions (`slack_reply`) injected into agent sessions via `createSdkMcpServer` |
| `src/sessions/manager.ts` | Channel → session ID mapping (in-memory + persisted to `~/.friday/sessions/channels.json`) |
| `src/sessions/queue.ts` | Per-channel FIFO queue with edit/delete support, emoji lifecycle helpers |
| `src/monitor/usage.ts` | Appends per-turn usage entries to `~/.friday/usage.jsonl` |
| `src/monitor/session-stats.ts` | Reads usage log, computes session aggregates (cost, tokens, cache hit rate, duration) |
| `src/monitor/health.ts` | Writes `~/.friday/health.json` heartbeat every 30s (pid, uptime, last heartbeat). Removed on clean shutdown. |

### Shared Package (`packages/shared`)

TypeScript types and utilities shared across services:

- `config.ts` — `FridayConfig` type, default values, `loadConfig()` function, path constants
- `usage.ts` — `UsageEntry` type for the JSONL usage log

### Usage Report (`tools/usage-report`)

Standalone CLI tool that reads `~/.friday/usage.jsonl` and reports usage stats without making any LLM calls. Run via `pnpm --filter @friday/usage-report run start` (or `-- -v` for token breakdown).

### Dashboard (`services/dashboard`)

Optional SvelteKit app for management. Reads `~/.friday/` state files via server-side load functions. Does not need the daemon running.

## Message Flow

### Linear (Non-Queued) Path

```
1. User posts message in channel
2. Slack sends event via Socket Mode WebSocket
3. Bolt SDK receives event, calls message handler
4. Message is enqueued (wasQueued=false) and drained immediately
5. Handler reacts with 👀 emoji on the message
6. Handler calls sendToAgent() with message text
7. Agent SDK spawns/resumes Claude Code CLI subprocess
8. CLI processes the request (may use tools: Read, Write, Bash, etc.)
9. If streaming: post "_..._" message, edit with chunks at 1/sec throttle
   If non-streaming: post response flat in channel (chunked if >4000 chars)
10. Handler removes 👀 emoji
```

### Queued (Out-of-Order) Path

When the agent is already processing a message, additional messages are queued:

```
1. User posts message while agent is busy
2. Handler reacts with 🕐 emoji (queued indicator)
3. Message is enqueued (wasQueued=true)
4. When the current turn completes, queue is drained as a batch
5. 🕐 swapped to 👀 on all batch messages
6. Batch messages are echoed as a blockquote in a "Working..." placeholder
7. Combined text is sent to agent as a single prompt
8. Placeholder is updated with the response
9. 👀 removed from all batch messages
```

Users can edit or delete queued messages before they're processed — edits update the queued text, deletes remove from queue and clear the 🕐 emoji.

### Error Path

```
1-6. Same as above
7. Agent throws an error
8. Handler reacts with ☢️ emoji on the original message
9. Error posted flat in channel (or updates the placeholder if one exists)
10. 👀 removed
```

### Compaction

When the Agent SDK detects conversation compaction:

```
1. SDK emits status: "compacting"
2. Handler posts "⏳ Compacting conversation..." in channel
3. SDK completes compaction
4. Handler updates message to "🗜️ Conversation was compacted"
```

### Slash Commands

| Command | Behavior |
|---------|----------|
| `/friday reset` | Clears channel session, posts confirmation (channel-visible) |
| `/friday session` | Shows session stats: ID, turns, cost, cache rate, age, duration, working dir (channel-visible) |
| `/friday help` | Lists commands (ephemeral, user-only) |

## State & Configuration

All persistent state lives in `~/.friday/`:

```
~/.friday/
├── config.json          — Runtime config (channel IDs, agent settings, formatting)
├── .env                 — Secrets (SLACK_APP_TOKEN, SLACK_BOT_TOKEN)
├── health.json          — Daemon heartbeat (pid, uptime, last beat). Present = running.
├── sessions/
│   └── channels.json    — Channel ID → Agent SDK session ID mapping
└── usage.jsonl          — Per-turn usage log (cost, tokens, cache hits, duration)
```

Agent SDK sessions are stored by Claude Code in `~/.claude/projects/<encoded-cwd>/`.

## Slack Connection

**Transport:** Socket Mode (outbound WebSocket, no public URL needed)

**Authentication:**
- App Token (`xapp-...`) — Socket Mode connection
- Bot Token (`xoxb-...`) — API calls (posting messages, reactions)

**Events subscribed:**
- `message.channels`, `message.groups`, `message.im` — message content
- `app_mention` — @mentions

**Current behavior:** All messages in the orchestrator channel are forwarded to the agent. Bot's own messages and subtypes (edits, joins, etc.) are filtered out.

## Agent Runtime

**SDK:** `@anthropic-ai/claude-agent-sdk` TypeScript V1 (`query()` API)

**Billing:** Uses Pro/Max subscription via Claude Code CLI's default auth. No `ANTHROPIC_API_KEY` needed. Validated in Phase 0 — see `phase0-billing-test/`.

**Prompt caching:** Handled automatically at the infrastructure level. 1-hour TTL on cached system prompt (~15k tokens). Subsequent turns in a resumed session cost ~58% less. Validated in Phase 0.

**Session continuity:** Each channel maps to a persistent Agent SDK session. The session ID is tracked in `~/.friday/sessions/channels.json` and passed via `resume: sessionId` on every `query()` call. This means the agent has full context of the conversation history within that channel. Use `/reset` in Slack to start a fresh session.

**Permission mode:** `bypassPermissions` — the agent can use all allowed tools without interactive confirmation. This is required since there's no human at the terminal to approve tool calls.

## Monorepo Structure

```
agent-friday/
├── packages/shared      — Shared types (config, usage)
├── packages/cli         — CLI entrypoint (@friday/cli)
├── services/friday      — Bridge daemon
├── services/dashboard   — Management GUI (SvelteKit)
├── tools/usage-report   — Standalone usage CLI (absorbed into @friday/cli)
└── bin/friday           — Dev shim (runs @friday/cli via tsx)
```

**Package manager:** pnpm workspaces
**Build orchestration:** Turborepo — builds `packages/shared` first, then services in parallel
**Language:** TypeScript throughout

### CLI (`packages/cli`)

Unified command-line interface for managing Friday. Provides both standalone commands (no daemon needed) and service management.

**Standalone commands:**
- `friday usage` — reads `~/.friday/usage.jsonl`, reports cost/token/cache stats (absorbs `tools/usage-report`)
- `friday config` — prints/validates `~/.friday/config.json`
- `friday status` — checks PID files and health.json for service state

**Service management:**
- `friday start [service]` — start daemon, dashboard, or all (detached, PID tracked in `~/.friday/pids/`)
- `friday stop [service]` — stop services via SIGTERM
- `friday restart <service>` — restart a specific service (required argument)

**Dev mode:**
- `friday dev start [service]` — start with tsx watch / hot reload (uses turbo for all)
- `friday dev restart <service>` — restart a specific service in dev mode

**Entry points:**
- `bin/friday` — dev shim, runs `packages/cli/src/index.ts` via tsx
- `npm install -g @friday/cli` — production install puts `friday` on PATH via npm bin linking
