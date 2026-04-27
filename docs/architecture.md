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
| `src/log.ts` | Structured JSON logger — all output goes through this (`ts`, `level`, `event`, context fields). Tees to `~/.friday/daemon.jsonl` and stdout/stderr. |
| `src/slack/app.ts` | Creates `@slack/bolt` App with Socket Mode, global error handler |
| `src/slack/events.ts` | Message handler, `/friday` commands, per-channel FIFO queue, streaming, compaction detection, image attachment handling |
| `src/agent/client.ts` | Wraps Agent SDK `query()`, streams text chunks, detects compaction, logs usage, passes MCP servers and system prompt; accepts multimodal prompts (text + images) |
| `src/agent/tools.ts` | Slack MCP tools (`slack_reply`) injected into agent sessions via `createSdkMcpServer` |
| `src/agent/agent-tools.ts` | Agent management MCP tools (`agent_create`, `agent_list`, `agent_status`, `agent_destroy`, `worktree_add`, `worktree_remove`) |
| `src/agent/lifecycle.ts` | Agent lifecycle — create/destroy Builders and Helpers, spawn/stop agent loops, restore on daemon restart |
| `src/agent/workspace.ts` | Workspace and git worktree management for Builder agents |
| `src/agent/prime.ts` | System prompt and first-turn prompt generation for typed agent sessions (Orchestrator, Builder, Helper, Scheduled) |
| `src/scheduler/scheduler.ts` | Scheduler loop — 30s interval checks for due scheduled agents, triggers execution, catches up missed runs on restart |
| `src/scheduler/trigger.ts` | Scheduled agent execution — spawns fresh session, injects state from previous run, writes run metadata |
| `src/scheduler/schedule-tools.ts` | Schedule management MCP tools (create, list, pause, resume, update, delete, trigger) |
| `src/sessions/registry.ts` | Agent registry CRUD — persisted to `~/.friday/agents.json`, hierarchy enforcement, unique name enforcement, session tracking |
| `src/sessions/manager.ts` | Channel → session ID mapping (in-memory + persisted to `~/.friday/sessions/channels.json`) |
| `src/sessions/queue.ts` | Per-channel FIFO queue with edit/delete support, emoji lifecycle helpers; `QueuedMessage` carries optional image attachments |
| `src/monitor/usage.ts` | Appends per-turn usage entries to `~/.friday/usage.jsonl` |
| `src/monitor/session-stats.ts` | Reads usage log, computes session aggregates (cost, tokens, cache hit rate, duration) |
| `src/monitor/health.ts` | Writes `~/.friday/health.json` heartbeat every 30s (pid, uptime, last heartbeat). Removed on clean shutdown. |
| `src/monitor/agent-health.ts` | Periodic agent health checks — detects stalled agents (no turn progress) and crashed agents (loop exited but status active). Notifies orchestrator via mail. |
| `src/memory/memory-tools.ts` | Memory MCP tools (`memory_search`, `memory_save`, `memory_update`, `memory_get`, `memory_forget`) for Orchestrator and Bare sessions |
| `src/memory/auto-recall.ts` | Builds a `<memory-context>` block prepended to each Orchestrator/Bare prompt — runs hybrid keyword search and embeds top-N entries verbatim so the agent never has to call `memory_search` first |
| `src/evolve/seed.ts` | Boot-time idempotent seed of the `scheduled-meta-daily` (cron `0 4 * * *`) and `scheduled-meta-weekly` (cron `0 5 * * 0`) agents — daily 24h scan + escalation, weekly 7-day scan + Jaccard re-cluster |
| `src/slack/feedback.ts` | Appender for `~/.friday/evolve/feedback.jsonl` — wired into the existing `message_changed` / `message_deleted` Slack handlers, no new scopes needed |
| `src/evolve/evolve-tools.ts` | Evolve MCP tools (`evolve_list`, `evolve_show`, `evolve_approve`, `evolve_reject`, `evolve_summarize_critical`) for the orchestrator |
| `src/slack/preflight.ts` | Boot-time Slack cleanup — patches interrupted messages and removes dangling emoji reactions from previous crashes |
| `src/slack/image-fetch.ts` | Authenticated download of Slack private image files; returns base64-encoded `ImageAttachment[]` |
| `src/comms/mail.ts` | Beads-backed inter-agent mail system with push delivery via EventEmitter. Uses `execFileSync` (not shell) to avoid injection. |
| `src/comms/mail-tools.ts` | Mail MCP tools (`mail_send`, `mail_check`, `mail_read`, `mail_close`) |
| `src/comms/mail-poller.ts` | Polls for orchestrator mail and triggers turns via `sendToAgent` |
| `src/events/bus.ts` | Singleton EventBus — typed EventEmitter with monotonic seq, ring buffer (200 events), replay for SSE reconnects |
| `src/events/server.ts` | SSE HTTP server (Node built-in `http`) — `/events` endpoint streams `FridayEvent`s, `/health` liveness check, CORS, `Last-Event-ID` replay |

### Shared Package (`packages/shared`)

TypeScript types and utilities shared across services:

- `config.ts` — `FridayConfig` type, default values, `loadConfig()` function, path constants
- `agents.ts` — Agent types (`AgentType`, `AgentStatus`), registry types (`OrchestratorEntry`, `BuilderEntry`, `HelperEntry`, `ScheduledEntry`), schedule spec, name validation
- `usage.ts` — `UsageEntry` type for the JSONL usage log
- `transcript.ts` — Session JSONL transcript parser: parses Claude Code session files into structured turns, supports full parse and last-N-turns, streaming tail via `fs.watch`, and human-readable formatting
- `inspect.ts` — Shared agent inspection logic: resolves agent → transcript path, builds structured `InspectResult`, formats as plain text or markdown. Used by CLI, Slack command, MCP tool, and dashboard.
- `events.ts` — `FridayEvent` discriminated union type for SSE events (agent lifecycle, turn streaming/completion, usage logging)

### Memory Package (`packages/memory`)

Persistent knowledge store for Orchestrator and Bare sessions. Memories are file-based markdown with YAML frontmatter stored at `~/.friday/memory/entries/`.

- `store.ts` — CRUD operations: `saveEntry`, `getEntry`, `updateEntry`, `forgetEntry`, `listEntries`, `touchRecall`. Markdown serialization with frontmatter.
- `search.ts` — Hybrid keyword search with recall frequency boosting (`log2(recallCount + 1)`). Tag filtering (AND logic). Score: title match (3pts), content match (1pt), tag exact match (5pts).
- `events.ts` — JSONL event logging at `~/.friday/memory/events.jsonl` for audit trail.

### Evolve Package (`packages/evolve`)

Self-improvement pipeline. Scans Friday's own logs for recurring pain (crashes, loop errors, scheduled-run failures), buckets by stable hash, and writes ranked proposals to `~/.friday/evolve/proposals/` for the user to approve, reject, or apply.

- `store.ts` — `Proposal` CRUD with markdown frontmatter; `Signal` payload serialized as inline JSON. Status lifecycle: `open → critical → approved → applied` (or `→ rejected`).
- `scan.ts` — Deterministic scanners over four sources, all self-excluding `scheduled-meta-*` activity to prevent feedback loops:
  - `scanDaemonLog()` — daemon events (crashes, loop errors, scheduled-run failures).
  - `scanFeedback()` — `~/.friday/evolve/feedback.jsonl` (Slack edit/delete + 3+ edits to the same message → `slack_retry_burst`).
  - `scanUsageLog()` — per-agent token-spike detection (single turn ≥ 4× the agent's median).
  - `scanTranscripts()` — consecutive user messages within 5 min with cosine token-overlap ≥ 0.6 (retry detection).
- `rank.ts` — Pure scoring: severity floor + log2 frequency + distinct-signal boost − blast-radius penalty. `isCritical()` requires score ≥ 80 AND (high severity OR count ≥ 5).
- `propose.ts` — Merges new occurrences into existing open proposals by signal hash; creates fresh ones for new hashes. `rerankAll()` recomputes scores at end of run.
- `clusters.ts` — `mergeClusters()` runs Jaccard overlap (≥ 0.5 default) on signal-hash sets across open proposals; uses union-find to collapse groups; writes one cluster file per component to `~/.friday/evolve/clusters/<id>.md` and stamps `clusterId` on members. Non-destructive: proposal ids are preserved.
- `apply.ts` — `applyProposal()` materializes `memory` proposals via `@friday/memory.saveEntry`, writes `prompt` proposals to `config.json` `agent.systemPrompt`, and deep-merges `config` proposals (JSON body) into `config.json`. A self-modification guard refuses prompt/config changes targeting any `scheduled-meta-*` agent. `code` proposals are dispatched to the orchestrator via `dispatch.ts`.
- `dispatch.ts` — `dispatchCodeProposal()` shells out to `bd` to (1) seed a Beads epic with the proposal body, targets, evidence pointers, and acceptance criteria, then (2) mail the orchestrator (`type:message,delivery:pending,from:evolve:<applier>`) with the epic id. Builder creation stays gated on the orchestrator's existing user-approval flow — evolve never spawns a Builder itself.
- `runs.ts` — Per-run audit log at `~/.friday/evolve/runs.jsonl`.
- `cli.ts` — `friday-evolve scan|cluster|list|show` invoked by the meta-agents.

Two meta-agents are seeded idempotently at daemon boot:
- `scheduled-meta-daily` (cron `0 4 * * *`) — 24h scan over all four sources; mails the orchestrator urgently when criticals exist.
- `scheduled-meta-weekly` (cron `0 5 * * 0`) — 7-day scan + Jaccard re-cluster; surfaces slow-burn patterns the daily run misses.

The orchestrator surfaces proposals via `friday-evolve` MCP tools.

### Dashboard (`services/dashboard`)

Optional SvelteKit app for management. Reads `~/.friday/` state files via server-side load functions. Works offline (static data), but connects to the daemon's SSE event server (port 7444) for real-time updates when the daemon is running.

**Live updates:** The root layout connects to the daemon's SSE endpoint via `EventSource`. Events trigger `invalidateAll()` to re-fetch server data. Transcript pages show in-progress streaming text. Sidebar status dots update via live overlays. Auto-reconnects on disconnect.

**Pages:**
- `/` — Home dashboard: status, usage stats, daily cost chart, agents, sessions, memory, config. Live: stats/charts/tables refresh on new turns.
- `/sessions` — Session explorer with hierarchical sidebar (agent tree + bare sessions) and transcript viewer. Live: streaming text, turn completion, agent lifecycle changes. Transcripts render markdown for prompts and responses (tool-call JSON and mid-turn streaming text stay plain).
- `/schedules` and `/schedules/<name>` — Scheduled agent list and detail. Detail page shows the assembled `taskPrompt`, `state.md`, and `last-run.md`, all rendered as markdown. Status overlays update live as runs trigger and complete.
- `/memory` and `/memory/<id>` — Memory explorer. Lists entries with tag filters and recall counts; detail page renders the markdown body.
- `/evolve` and `/evolve/<id>` — Self-improvement backlog. Lists proposals with status filters (defaults to open + critical + approved); detail page renders signals and rationale, with Approve & apply / Reject form actions. Memory-type proposals materialize a new memory entry on approve. Prompt/config types write to `~/.friday/config.json` (with a self-modification guard for `scheduled-meta-*` targets).

## Message Flow

### Linear (Non-Queued) Path

```
1. User posts message in channel (text, image files, or both)
2. Slack sends event via Socket Mode WebSocket
3. Bolt SDK receives event, calls message handler
4. If message has image files, they are fetched via authenticated download
   (Slack private URLs require the bot token) and base64-encoded
5. Message is enqueued (wasQueued=false) and drained immediately
6. Handler reacts with 👀 emoji on the message
7. Handler calls sendToAgent() with text and any image content blocks
8. Agent SDK spawns/resumes Claude Code CLI subprocess
9. CLI processes the request (may use tools: Read, Write, Bash, etc.)
10. If streaming: post "_..._" message, edit with chunks at 1/sec throttle
    If non-streaming: post response flat in channel (chunked if >4000 chars)
11. Handler removes 👀 emoji
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
├── schedules/           — Scheduled agent state directories (<name>/state.md, last-run.md)
├── usage.jsonl          — Per-turn usage log (cost, tokens, cache hits, duration)
└── daemon.jsonl         — Daemon structured log (JSONL, teed from stdout)
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

Friday supports a multi-tier agent model for orchestrating complex work:

```
Orchestrator (singular, root)
├── Builder (long-lived, has workspace with worktrees)
│   ├── Helper (short-lived, task-focused)
│   └── Helper
├── Builder
│   └── Helper
└── Scheduled (autonomous, cron/one-shot, no parent)
```

### Agent Types

| Type | Lifecycle | Creates | Capabilities |
|------|----------|---------|-------------|
| **Orchestrator** | Singleton, managed by Slack event handler | Builders, Helpers, Scheduled | Full tool access, Slack communication, agent management, schedule management |
| **Builder** | Long-lived, daemon-managed loop | Helpers (not Builders) | Workspace with git worktrees, project-scoped work, plan-then-execute |
| **Helper** | Short-lived, daemon-managed loop | Nothing | Single-task execution, reports to parent |
| **Scheduled** | Autonomous, triggered by cron/one-shot | Nothing | Periodic autonomous work, escalation to orchestrator via mail |

### Agent Naming

Agent names are permanent — once used, a name can never be reused, even after the agent is destroyed. Names follow the format `<type>-<kebab-case-descriptor>` and must be descriptive enough to avoid collisions:

- Good: `builder-blog-redesign-2026`, `helper-cli-perf-audit`
- Bad: `builder-blog` (too generic, will collide if another blog builder is ever needed)

The orchestrator and builder system prompts include this guidance. The registry rejects duplicate names with an error suggesting a more descriptive alternative.

### Agent Lifecycle

Builders and Helpers run as background loops in the daemon:

1. **Create** — register in `~/.friday/agents.json`, set up workspace (Builders), spawn loop
2. **Loop** — `query()` turn with system prompt and first-turn prompt → process result → mark idle
3. **Destroy** — stop loop, destroy workspace (Builders), remove from registry (recursive for children)

On daemon restart, active agents are restored from the registry and their loops are resumed using stored session IDs.

**Mail-delivery loop contract** (`src/agent/lifecycle.ts`):

The outer agent loop runs a `query()` turn **only when `prompt` has been freshly assigned from real pending mail** (or on initial startup). After a turn completes:

1. An inter-turn `buildMailPrompt()` check runs. If mail is found, `prompt` is set and the outer loop continues immediately.
2. If no mail, the agent goes idle and enters an **inner wait loop** that repeatedly calls `waitForMail()` until mail actually arrives. The inner loop handles spurious wakeups (the 60-second fallback timer fires; a push event arrives for an already-processed message) by staying idle rather than falling through.
3. Only when the inner loop finds pending mail does it set `prompt`, update status to `active`, and break out — allowing the outer loop to run the next turn.

This invariant prevents stale-prompt reinjection: if the 60-second fallback timer fires and `buildMailPrompt()` returns null, the agent stays idle and does not re-run a query turn with the previous mail notification as the prompt.

### Scheduled Agents

Scheduled agents run autonomous periodic tasks without orchestrator involvement. They support both recurring cron schedules and one-shot timed execution.

**How they work:**
1. The scheduler (`src/scheduler/scheduler.ts`) runs a 30-second `setInterval` that checks all non-paused scheduled agents
2. If `nextRunAt <= now`, the scheduler triggers a fresh `query()` session with the agent's `taskPrompt`
3. The agent executes its task, updates its state file, and exits. It goes dormant until the next trigger.
4. If the agent encounters issues, it escalates via `mail_send` to the orchestrator

**Run-to-run continuity (the run journal):** Each scheduled agent has a state directory at `~/.friday/schedules/<name>/` containing:
- `state.md` — free-form scratchpad. The daemon **auto-injects** it into the next run's first-turn prompt under "State from your previous run" — the agent doesn't read it manually. The agent writes a fresh `state.md` at the end of each run with anything the next run needs.
- `last-run.md` — auto-written metadata (timestamp, duration, session ID, status). Also auto-injected into the next run.

The orchestrator's system prompt explicitly teaches this convention so it picks `<stateDir>/state.md` (not `/tmp`) when designing taskPrompts. Updates to `taskPrompt` only affect future runs — `schedule_show` reveals the current configuration verbatim, `schedule_preview` shows the assembled first-turn prompt, and `schedule_revert` rolls back the last `taskPrompt` change (history capped at 10).

**Key behaviors:**
- New session each run (avoids ballooning context/cost)
- Concurrent run guard — won't trigger if already running
- One-shot schedules auto-pause after firing (preserve over delete)
- Missed schedules on daemon restart catch up with at most one immediate execution
- Atomic registry writes; cron and runAt validated at write time
- In-flight runs cooperatively aborted on SIGTERM via `drainScheduledRuns`

### MCP Tools

Agents interact with the system via MCP tool servers injected into their sessions:

| Server | Tools | Available To |
|--------|-------|-------------|
| `friday-slack` | `slack_reply` | Orchestrator |
| `friday-agents` | `agent_create`, `agent_list`, `agent_status`, `agent_destroy`, `agent_inspect`, `worktree_add`, `worktree_remove`, `workspace_cleanup` | Orchestrator, Builders (scoped to own children) |
| `friday-mail` | `mail_send`, `mail_check`, `mail_read`, `mail_close` | All agent types |
| `friday-scheduler` | `schedule_create`, `schedule_list`, `schedule_show`, `schedule_preview`, `schedule_pause`, `schedule_resume`, `schedule_update`, `schedule_revert`, `schedule_delete`, `schedule_trigger` | Orchestrator |
| `friday-memory` | `memory_search`, `memory_save`, `memory_update`, `memory_get`, `memory_forget` | Orchestrator, Bare sessions (auto-recall context block injected before every turn) |
| `friday-evolve` | `evolve_list`, `evolve_show`, `evolve_approve`, `evolve_reject`, `evolve_summarize_critical` | Orchestrator |

### Workspaces

Builders work in isolated workspaces under `~/.friday/working/workspaces/<builder-name>/`. Each workspace contains git worktrees from local repos or bare clones of remote repos cached in `~/.friday/repos/<org>/<repo>/`. Workspaces are created automatically when a Builder is created and cleaned up when destroyed.

## Monorepo Structure

```
agent-friday/
├── packages/shared      — Shared types (config, usage, transcript parser)
├── packages/cli         — CLI entrypoint (@friday/cli)
├── packages/memory      — Memory system (file-based store, search, events)
├── packages/evolve      — Self-improvement pipeline (scan → propose → rank → apply)
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
- `friday schedule` — manage scheduled agents (list, create, pause, resume, trigger, delete)

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
| `@friday/evolve` | `store.test.ts`, `scan.test.ts`, `rank.test.ts`, `propose.test.ts`, `clusters.test.ts`, `apply.test.ts` | Proposal CRUD + frontmatter roundtrip; deterministic scanners with `scheduled-meta-*` self-exclusion (daemon, feedback, usage spike, transcript retry); scoring + critical thresholds; merge-by-hash and rerank-all; Jaccard cluster merge with union-find; apply pipeline for memory/prompt/config/code (code dispatches via injected `bd` runner — asserts epic body, mail labels, error propagation, self-modification guard) |
| `@friday/cli` | `help.test.ts`, `services.test.ts`, 8× command tests | Help text, PID management, isRunning, parseServiceArg, findMonorepoRoot, all CLI commands including inspect, transcript, and schedule management |
| `@friday/daemon` | `queue.test.ts`, `manager.test.ts`, `helpers.test.ts`, `usage.test.ts`, `config.test.ts`, `registry.test.ts`, `workspace.test.ts`, `workspace-guard.test.ts`, `prime.test.ts`, `client.test.ts`, `agent-tools.test.ts`, `preflight.test.ts`, `image-fetch.test.ts`, `agent-health.test.ts`, `mail.test.ts`, `mail-poller.test.ts`, `lifecycle.test.ts`, `auto-recall.test.ts`, `events/bus.test.ts`, `events/server.test.ts`, `scheduler/scheduler.test.ts`, `scheduler/trigger.test.ts` | FIFO queue ops, session persistence, Slack helpers, usage logging, runtime config, agent registry CRUD, workspace/worktree lifecycle, builder workspace path guard (PreToolCall hook), system prompt generation, thinking indicator and status callbacks, MCP agent tools, boot preflight cleanup, Slack image fetch and base64 encoding, agent health monitoring (stall/crash detection), mail CRUD and push/poll delivery, agent loop idle-wait invariant (no stale-prompt reinjection), memory auto-recall context block assembly, EventBus publish/replay/ring buffer, SSE server endpoints/streaming/reconnect replay, scheduler check loop and cron parsing, scheduled agent triggering and state injection |

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
