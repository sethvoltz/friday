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
| `src/slack/app.ts` | Creates `@slack/bolt` App with Socket Mode |
| `src/slack/events.ts` | Message event handler: emoji reactions, agent dispatch, response chunking, error threading |
| `src/agent/client.ts` | Wraps Agent SDK `query()`, extracts text responses, logs usage data |

### Shared Package (`packages/shared`)

TypeScript types and utilities shared across services:

- `config.ts` — `FridayConfig` type, default values, `loadConfig()` function, path constants
- `usage.ts` — `UsageEntry` type for the JSONL usage log

### Dashboard (`services/dashboard`)

Optional SvelteKit app for management. Reads `~/.friday/` state files via server-side load functions. Does not need the daemon running.

## Message Flow

### Happy Path

```
1. User posts message in #orchestrator channel
2. Slack sends event via Socket Mode WebSocket
3. Bolt SDK receives event, calls message handler
4. Handler reacts with 👀 emoji on the message
5. Handler calls sendToAgent() with message text
6. Agent SDK spawns Claude Code CLI subprocess
7. CLI processes the request (may use tools: Read, Write, Bash, etc.)
8. CLI returns response through SDK async iterator
9. Handler posts response flat in channel (chunked if >4000 chars)
10. Handler removes 👀 emoji
```

### Error Path

```
1-6. Same as happy path
7. CLI or SDK throws an error
8. Handler reacts with ☢️ emoji on the original message
9. Handler posts error details in a thread on the original message
10. Handler removes 👀 emoji
```

Errors are threaded to keep the main channel clean. The ☢️ reaction on the original message signals visually that something went wrong without needing to read the thread.

## State & Configuration

All persistent state lives in `~/.friday/`:

```
~/.friday/
├── config.json          — Runtime config (channel IDs, agent settings, formatting)
├── .env                 — Secrets (SLACK_APP_TOKEN, SLACK_BOT_TOKEN)
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
├── services/friday      — Bridge daemon
├── services/dashboard   — Management GUI (SvelteKit)
└── tools/usage-report   — CLI usage introspection (Phase 4)
```

**Package manager:** pnpm workspaces
**Build orchestration:** Turborepo — builds `packages/shared` first, then services in parallel
**Language:** TypeScript throughout
