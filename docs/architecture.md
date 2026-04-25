# Friday Architecture

## System Overview

Friday is a local-first Slack-to-Claude-Code bridge that lets you command an AI orchestrator agent from anywhere via Slack. Messages flow from Slack through a local daemon to Claude Code sessions running on your machine.

```
Slack (Socket Mode WS) → Friday Daemon → Claude Agent SDK → Claude Code CLI → Anthropic API
```

The daemon is a Node.js process that maintains a persistent WebSocket to Slack and manages Claude Code sessions. It is designed as a well-behaved Unix daemon that any process manager can wrap.

## Design Principles

**Preserve over delete.** Err on the side of preserving data — logs, server state, chat messages — over deleting it. When cleaning up (Slack preflight, workspace teardown, session management), prefer updating or patching over removal. Data loss is harder to recover from than clutter. Exceptions will come up case-by-case, and that's fine — but the default is always preserve.

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
| `src/agent/tools.ts` | Slack MCP tools (`slack_reply`) injected into agent sessions via `createSdkMcpServer` |
| `src/agent/agent-tools.ts` | Agent management MCP tools (`agent_create`, `agent_list`, `agent_status`, `agent_destroy`, `worktree_add`, `worktree_remove`) |
| `src/agent/lifecycle.ts` | Agent lifecycle — create/destroy Builders and Agents, spawn/stop agent loops, restore on daemon restart |
| `src/agent/workspace.ts` | Workspace and git worktree management for Builder agents |
| `src/agent/prime.ts` | System prompt and first-turn prompt generation for typed agent sessions (Orchestrator, Builder, Helper) |
| `src/sessions/registry.ts` | Agent registry CRUD — persisted to `~/.friday/agents.json`, hierarchy enforcement, session tracking |
| `src/sessions/manager.ts` | Channel → session ID mapping (in-memory + persisted to `~/.friday/sessions/channels.json`) |
| `src/sessions/queue.ts` | Per-channel FIFO queue with edit/delete support, emoji lifecycle helpers |
| `src/monitor/usage.ts` | Appends per-turn usage entries to `~/.friday/usage.jsonl` |
| `src/monitor/session-stats.ts` | Reads usage log, computes session aggregates (cost, tokens, cache hit rate, duration) |
| `src/monitor/health.ts` | Writes `~/.friday/health.json` heartbeat every 30s (pid, uptime, last heartbeat). Removed on clean shutdown. |
| `src/monitor/agent-health.ts` | Periodic agent health checks — detects stalled agents (no turn progress) and crashed agents (loop exited but status active). Notifies orchestrator via mail. |
| `src/memory/memory-tools.ts` | Memory MCP tools (`memory_search`, `memory_save`, `memory_get`, `memory_forget`) for Orchestrator and Bare sessions |
| `src/slack/preflight.ts` | Boot-time Slack cleanup — patches interrupted messages and removes dangling emoji reactions from previous crashes |
| `src/comms/mail.ts` | Beads-backed inter-agent mail system with push delivery via EventEmitter |
| `src/comms/mail-tools.ts` | Mail MCP tools (`mail_send`, `mail_check`, `mail_read`, `mail_close`) |
| `src/comms/mail-poller.ts` | Polls for orchestrator mail and triggers turns via `sendToAgent` |
| `src/events/bus.ts` | Singleton EventBus — typed EventEmitter with monotonic seq, ring buffer (200 events), replay for SSE reconnects |
| `src/events/server.ts` | SSE HTTP server (Node built-in `http`) — `/events` endpoint streams `FridayEvent`s, `/health` liveness check, CORS, `Last-Event-ID` replay |

### Shared Package (`packages/shared`)

TypeScript types and utilities shared across services:

- `config.ts` — `FridayConfig` type, default values, `loadConfig()` function, path constants
- `agents.ts` — Agent types (`AgentType`, `AgentStatus`), registry types (`OrchestratorEntry`, `BuilderEntry`, `HelperEntry`), name validation
- `usage.ts` — `UsageEntry` type for the JSONL usage log
- `transcript.ts` — Session JSONL transcript parser: parses Claude Code session files into structured turns, supports full parse and last-N-turns, streaming tail via `fs.watch`, and human-readable formatting
- `inspect.ts` — Shared agent inspection logic: resolves agent → transcript path, builds structured `InspectResult`, formats as plain text or markdown. Used by CLI, Slack command, MCP tool, and dashboard.
- `events.ts` — `FridayEvent` discriminated union type for SSE events (agent lifecycle, turn streaming/completion, usage logging)

### Memory Package (`packages/memory`)

Persistent knowledge store for Orchestrator and Bare sessions. Memories are file-based markdown with YAML frontmatter stored at `~/.friday/memory/entries/`.

- `store.ts` — CRUD operations: `saveEntry`, `getEntry`, `updateEntry`, `forgetEntry`, `listEntries`, `touchRecall`. Markdown serialization with frontmatter.
- `search.ts` — Hybrid keyword search with recall frequency boosting (`log2(recallCount + 1)`). Tag filtering (AND logic). Score: title match (3pts), content match (1pt), tag exact match (5pts).
- `events.ts` — JSONL event logging at `~/.friday/memory/events.jsonl` for audit trail.

### Dashboard (`services/dashboard`)

Optional SvelteKit app for management. Reads `~/.friday/` state files via server-side load functions. Works offline (static data), but connects to the daemon's SSE event server (port 7444) for real-time updates when the daemon is running.

**Live updates:** The root layout connects to the daemon's SSE endpoint via `EventSource`. Events trigger `invalidateAll()` to re-fetch server data. Transcript pages show in-progress streaming text. Sidebar status dots update via live overlays. Auto-reconnects on disconnect.

**Pages:**
- `/` — Home dashboard: status, usage stats, daily cost chart, agents, sessions, memory, config. Live: stats/charts/tables refresh on new turns.
- `/sessions` — Session explorer with hierarchical sidebar (agent tree + bare sessions) and transcript viewer. Live: streaming text, turn completion, agent lifecycle changes.

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
| `/friday reset` | Clears channel session, posts confirmation. Blocked on the orchestrator channel (long-lived session). |
| `/friday session` | Shows session stats: ID, turns, cost, cache rate, age, duration, working dir (channel-visible) |
| `/friday agents` | Lists all active agents with type, name, status |
| `/friday inspect <agent>` | Shows compact summary of agent's last 3 turns: status, parent, tool calls, cost (ephemeral) |
| `/friday help` | Lists commands (ephemeral, user-only) |

## State & Configuration

All persistent state lives in `~/.friday/`:

```
~/.friday/
├── config.json          — Runtime config (channel IDs, agent settings, formatting)
├── .env                 — Secrets (SLACK_APP_TOKEN, SLACK_BOT_TOKEN)
├── health.json          — Daemon heartbeat (pid, uptime, last beat, eventServerPort). Present = running.
├── agents.json          — Agent registry (type, status, session IDs, parent/children, workspace)
├── sessions/
│   └── channels.json    — Channel ID → Agent SDK session ID mapping
├── working/
│   └── workspaces/      — Builder workspaces with git worktrees
├── repos/               — Bare clone cache for remote repos (<org>/<repo>/)
├── memory/
│   ├── entries/         — Memory entries as markdown with YAML frontmatter
│   └── events.jsonl     — Memory operation audit log
├── beads/               — Beads task/epic tracker data
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

## Agent Hierarchy

Friday supports a three-tier agent model for orchestrating complex work:

```
Orchestrator (singular, root)
├── Builder (long-lived, has workspace with worktrees)
│   ├── Helper (short-lived, task-focused)
│   └── Helper
└── Builder
    └── Helper
```

### Agent Types

| Type | Lifecycle | Creates | Capabilities |
|------|----------|---------|-------------|
| **Orchestrator** | Singleton, managed by Slack event handler | Builders, Helpers | Full tool access, Slack communication, agent management |
| **Builder** | Long-lived, daemon-managed loop | Helpers (not Builders) | Workspace with git worktrees, project-scoped work, plan-then-execute |
| **Helper** | Short-lived, daemon-managed loop | Nothing | Single-task execution, reports to parent |

### Agent Lifecycle

Builders and Agents run as background loops in the daemon:

1. **Create** — register in `~/.friday/agents.json`, set up workspace (Builders), spawn loop
2. **Loop** — `query()` turn with system prompt and first-turn prompt → process result → mark idle
3. **Destroy** — stop loop, destroy workspace (Builders), remove from registry (recursive for children)

On daemon restart, active agents are restored from the registry and their loops are resumed using stored session IDs.

### MCP Tools

Agents interact with the system via MCP tool servers injected into their sessions:

| Server | Tools | Available To |
|--------|-------|-------------|
| `friday-slack` | `slack_reply` | Orchestrator |
| `friday-agents` | `agent_create`, `agent_list`, `agent_status`, `agent_destroy`, `agent_inspect`, `worktree_add`, `worktree_remove`, `workspace_cleanup` | Orchestrator, Builders (scoped to own children) |
| `friday-mail` | `mail_send`, `mail_check`, `mail_read`, `mail_close` | All agent types |
| `friday-memory` | `memory_search`, `memory_save`, `memory_get`, `memory_forget` | Orchestrator, Bare sessions |

### Workspaces

Builders work in isolated workspaces under `~/.friday/working/workspaces/<builder-name>/`. Each workspace contains git worktrees from local repos or bare clones of remote repos cached in `~/.friday/repos/<org>/<repo>/`. Workspaces are created automatically when a Builder is created and cleaned up when destroyed.

## Monorepo Structure

```
agent-friday/
├── packages/shared      — Shared types (config, usage, transcript parser)
├── packages/cli         — CLI entrypoint (@friday/cli)
├── packages/memory      — Memory system (file-based store, search, events)
├── services/friday      — Bridge daemon
├── services/dashboard   — Management GUI (SvelteKit)
├── bin/friday           — Dev shim (runs @friday/cli via tsx)
└── docs/                — Documentation index, setup, config, architecture
```

**Package manager:** pnpm workspaces
**Build orchestration:** Turborepo — builds `packages/shared` first, then services in parallel
**Language:** TypeScript throughout

### CLI (`packages/cli`)

Unified command-line interface for managing Friday. Provides both standalone commands (no daemon needed) and service management.

**Standalone commands:**
- `friday usage` — reads `~/.friday/usage.jsonl`, reports cost/token/cache stats
- `friday config` — prints/validates `~/.friday/config.json`
- `friday status` — checks PID files and health.json for service state
- `friday inspect <agent>` — show last N turns from an agent's session transcript (supports `--turns N`, `--full`, `--follow/-f`, `--no-tools`)
- `friday transcript <agent>` — export full session transcript as markdown (supports `--output <file>`)

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

## Testing

### Framework & Runner

All packages use **Vitest** (`vitest run`). Tests are co-located with source files as `*.test.ts`. The root `pnpm test` runs `turbo run test`, which builds `@friday/shared` first (since other packages depend on it) then runs all package tests in parallel.

### Running Tests

```bash
# Full suite (all packages, via Turborepo)
pnpm test

# Single package
pnpm --filter @friday/shared run test
pnpm --filter @friday/cli run test
pnpm --filter @friday/daemon run test

# Single file
pnpm --filter @friday/cli exec vitest run src/commands/start.test.ts
```

### Coverage by Package

| Package | Test files | What's tested |
|---------|-----------|---------------|
| `@friday/shared` | `config.test.ts`, `agents.test.ts`, `transcript.test.ts`, `inspect.test.ts` | Path derivation, defaults, deep merge, agent name validation, name building, JSONL transcript parsing, turn grouping, tool call tracking, formatting, agent inspection (path resolution, result building, plain/markdown formatting) |
| `@friday/memory` | `store.test.ts`, `search.test.ts` | Memory CRUD, serialization roundtrip, recall tracking, hybrid search scoring, tag filtering, recall frequency boosting, event logging |
| `@friday/cli` | `help.test.ts`, `services.test.ts`, 7× command tests | Help text, PID management, isRunning, parseServiceArg, findMonorepoRoot, all CLI commands including inspect and transcript |
| `@friday/daemon` | `queue.test.ts`, `manager.test.ts`, `helpers.test.ts`, `usage.test.ts`, `config.test.ts`, `registry.test.ts`, `workspace.test.ts`, `prime.test.ts`, `client.test.ts`, `agent-tools.test.ts`, `preflight.test.ts`, `agent-health.test.ts`, `mail.test.ts`, `mail-tools.test.ts`, `events/bus.test.ts`, `events/server.test.ts` | FIFO queue ops, session persistence, Slack helpers, usage logging, runtime config, agent registry CRUD, workspace/worktree lifecycle, system prompt generation, thinking indicator, MCP agent tools, boot preflight cleanup, agent health monitoring (stall/crash detection), mail CRUD and delivery, EventBus publish/replay/ring buffer, SSE server endpoints/streaming/reconnect replay |

### Conventions

- **Mocking external deps:** Mock `@friday/shared` or `node:os` to redirect paths to temp dirs. Use `vi.mock()` before `await import()`.
- **Temp directories:** Always include `process.pid` and `Date.now()` in temp dir names for CI safety. Clean up in `afterEach`.
- **Process exit:** When testing code that calls `process.exit(1)`, spy on both `process.exit` (throw to break flow) and `console.error` (suppress output).
- **Module state:** For modules with module-level mutable state (queues, sessions), either call the initializer in each test or export a `_resetForTesting()` function.
- **No e2e yet:** Playwright tests for the SvelteKit dashboard are planned but not yet implemented.

### CI Notes

- All tests are deterministic — no network calls, no real Slack connections, no real Claude sessions.
- Tests use temp dirs under `os.tmpdir()` with unique names; no hardcoded paths.
- `tsconfig.json` in each package excludes `src/**/*.test.ts` so test files don't end up in `dist/`.
