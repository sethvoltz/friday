# Architecture Decision Records

## ADR-001: Slack Socket Mode over Webhooks or Tunnels

**Date:** 2026-04-22
**Status:** Accepted

**Context:** We need to get Slack messages to a daemon running on a local machine. Options: HTTP webhooks (requires public URL), tunnels (ngrok/Cloudflare Tunnel), or Socket Mode (outbound WebSocket).

**Decision:** Socket Mode via `@slack/bolt`.

**Rationale:**
- No public URL, no open ports, works behind NAT/firewalls
- No tunnel process to manage or URLs that change on restart
- This is the same approach OpenClaw uses as their default
- Slack's Bolt SDK has first-class Socket Mode support

**Consequences:**
- Requires an App-Level Token with `connections:write` scope
- Slightly higher latency than direct webhooks (negligible for our use case)
- Limited to 10 concurrent connections per app (not a concern for single-user)

---

## ADR-002: Claude Agent SDK (TypeScript V1) as the Runtime

**Date:** 2026-04-22
**Status:** Accepted

**Context:** We need to programmatically send prompts to Claude and receive responses. Options: raw Claude Code CLI stdin/stdout, Claude Agent SDK (V1 query API), Agent SDK V2 preview, or direct Anthropic API.

**Decision:** Agent SDK TypeScript V1 (`query()` + `resume` + `continue`).

**Rationale:**
- Wraps Claude Code CLI as subprocess — inherits Pro subscription billing (validated Phase 0)
- Built-in session management: resume by ID, continue, fork
- Prompt caching works automatically at infrastructure level (validated Phase 0: 58% cost reduction on resumed turns, 1h TTL)
- MCP tool injection for custom orchestrator capabilities
- Same language as the Slack bridge (TypeScript)

**Alternatives considered:**
- **V2 SDK (`unstable_v2_createSession`)** — Cleaner `send()`/`stream()` API, but explicitly labeled unstable, missing session forking. Will revisit when `unstable_` prefix drops. Abstraction layer in `agent/client.ts` makes swap trivial.
- **Direct Anthropic API** — Requires separate API billing, no built-in tool execution, would need to reimplement the agent loop
- **Raw CLI control (tmux + stdin/stdout)** — Fallback option if SDK has issues. More fragile but guaranteed to work with Pro billing and caching.

**Consequences:**
- Tied to Claude Code CLI subprocess model
- `query()` is sequential per session — concurrent messages must be queued

---

## ADR-003: Pro/Max Subscription Billing (Not API Keys)

**Date:** 2026-04-22
**Status:** Validated

**Context:** The Agent SDK can potentially use either API key billing or the user's Claude Pro/Max subscription via the CLI subprocess. The billing path affects both cost model and token availability.

**Decision:** Use Pro subscription billing by default. Do not set `ANTHROPIC_API_KEY`.

**Validation:** Phase 0 testing confirmed:
- Single-turn and multi-turn queries billed to subscription
- No `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` needed
- Extra Usage toggle OFF — queries succeed purely on subscription
- Cost: ~$0.02 first turn, ~$0.008 subsequent turns (with caching)

**Risks:**
- Pro plan has shared daily usage limits (web + CLI + SDK all draw from the same pool)
- Heavy orchestrator usage could exhaust daily budget
- If usage grows significantly, Max plan ($100/mo, 5x limits) may be warranted

---

## ADR-004: Flat Channel Responses and Errors

**Date:** 2026-04-22
**Status:** Accepted (updated)

**Context:** The orchestrator Slack channel mirrors a Claude Code CLI session. Responses could be posted flat in the channel or threaded under the original message.

**Decision:** All responses and errors post flat in the channel. The ☢️ reaction on the original message signals an error visually.

**Rationale:**
- The channel IS the conversation — threading any response would break the conversational flow and make it hard to read linearly
- With queued/out-of-order messages, threaded errors would land on the wrong message or be hard to find
- The ☢️ reaction on the original message provides a clear visual signal without needing a separate thread

**History:** Initially errors were threaded to keep the channel "clean," but in practice this was more confusing than helpful — especially with batched/queued messages where the thread parent might not be the right context.

---

## ADR-005: pnpm Workspaces + Turborepo

**Date:** 2026-04-22
**Status:** Accepted

**Context:** The project has multiple packages (shared types, daemon, dashboard, CLI tools). Need dependency management and build orchestration.

**Decision:** pnpm workspaces for package management, Turborepo for build orchestration.

**Rationale:**
- pnpm: strict dependency management, workspace linking, user already requires it
- Turborepo: lightweight task runner that layers on top of pnpm. Handles build ordering (shared before services), caching (skip unchanged packages), and parallel execution
- Nx was considered but is heavier than needed for a single-developer project

---

## ADR-006: `~/.friday/` for Configuration and State

**Date:** 2026-04-22
**Status:** Accepted

**Context:** The daemon needs config (channel IDs, agent settings) and secrets (Slack tokens). These need to persist across restarts and be editable outside the repo.

**Decision:** All runtime config and state lives in `~/.friday/`. Config in JSON, secrets in `.env`, usage logs in JSONL.

**Rationale:**
- Separates config from code — no secrets in the repo
- Standard Unix convention for user-level config (`~/.tool/`)
- JSON is simple, widely supported, and readable by both the daemon and dashboard
- JSONL for usage logs: append-only, easy to parse line-by-line, no corruption risk from crashes mid-write

---

## ADR-007: SvelteKit for Dashboard

**Date:** 2026-04-22
**Status:** Accepted

**Context:** We want an optional management GUI. It needs to read filesystem state (`~/.friday/` files) and display it.

**Decision:** SvelteKit with Vite.

**Rationale:**
- TypeScript-native — same language as the rest of the project
- Server-side load functions can read the filesystem directly (no separate API server needed)
- Lightweight, fast dev server, good DX
- The dashboard is optional — Friday runs standalone without it

---

## ADR-008: Daemon Design (Process Manager Agnostic)

**Date:** 2026-04-22
**Status:** Accepted

**Context:** The daemon needs to run persistently. Users may prefer different process managers (launchd, systemd, pm2, tmux).

**Decision:** Build a well-behaved Unix daemon. Do not bake in any specific process manager.

**Contract:**
- Single entrypoint: `node dist/index.js`
- Reads config from `~/.friday/`
- Logs structured JSON to stdout
- Handles SIGTERM/SIGINT for graceful shutdown
- Non-zero exit on unrecoverable error
- Process manager handles restart, log routing, boot start

---

## ADR-009: SDK MCP Server for Agent-to-Slack Communication

**Date:** 2026-04-22
**Status:** Accepted

**Context:** The agent needs to proactively post messages to Slack (status updates, progress reports) without waiting for a turn to complete. The Agent SDK supports injecting MCP servers via `mcpServers` in query options.

**Decision:** Use `createSdkMcpServer()` from the Agent SDK to define in-process MCP tools. The `slack_reply` tool receives the Slack `WebClient` instance via closure and posts messages directly.

**Rationale:**
- In-process MCP (SDK type) — no subprocess or network hop, the tool handler runs in the same Node process as the daemon
- The `tool()` helper provides typed schemas via Zod, matching the SDK's expected interface
- MCP servers are passed per-query, so we can give the orchestrator `slack_reply` while keeping independent sessions restricted
- The agent receives the channel ID via system prompt injection, so it knows where to post

**Consequences:**
- MCP tools are recreated each turn (stateless by design — the `WebClient` is the only state, shared via closure)
- Only the orchestrator session gets the `friday-slack` MCP server; independent sessions have no Slack tools

---

## ADR-010: Configurable System Prompt via Config

**Date:** 2026-04-22
**Status:** Accepted

**Context:** The orchestrator's behavior (skills, personality, instructions) needs to be configurable without code changes. The Agent SDK supports `systemPrompt` as a string or preset-with-append.

**Decision:** Add optional `systemPrompt` field to `AgentConfig` in `~/.friday/config.json`. When set, it's appended to the Claude Code default preset. Channel context (channel ID) is always injected.

**Rationale:**
- Appending to the default preset (`{ type: 'preset', preset: 'claude_code', append: ... }`) preserves Claude Code's built-in capabilities (tools, memory, CLAUDE.md loading) while adding custom instructions
- The orchestrator skill can be loaded purely via config — no code deployment needed to change agent behavior
- Channel ID injection in the system prompt lets the agent use `slack_reply` without being told which channel to target

---

## ADR-016: Memory as Shared Package with File-Based Storage

**Date:** 2026-04-23
**Status:** Accepted

**Context:** The Orchestrator and Bare sessions need persistent memory — decisions, user preferences, project context, lessons learned — that survives across sessions and daemon restarts. This is the "why" that doesn't live in code, tasks, or git history.

**Decision:** Memory lives in `packages/memory` as a reusable package, exposed to agents via MCP tools. Storage is file-based markdown with YAML frontmatter.

**Design:**
- **Storage:** One markdown file per entry at `~/.friday/memory/entries/<id>.md`. YAML frontmatter holds metadata (title, tags, createdBy, timestamps, recall count). Body holds content.
- **Search:** Hybrid keyword scoring — title match (3pts), content match (1pt), tag exact match (5pts). Recall frequency boost via `log2(recallCount + 1)` rewards memories that keep proving useful.
- **Recall tracking:** Each search result increments the entry's recall count, creating a natural signal for memory importance without manual curation.
- **Event logging:** All operations (save, update, forget, search, recall) are appended to `~/.friday/memory/events.jsonl` for audit.
- **Access control:** Orchestrator and Bare sessions get full read/write. Builders and Agents have no direct access — the Orchestrator provides context on a need-to-know basis via mail.

**Rationale:**
- Markdown files are human-readable, diffable, and trivially backed up
- No database dependency — consistent with the `~/.friday/` file-based state model
- Hybrid keyword search is good enough for V1 without vector embeddings or external services
- Recall frequency is a cheap proxy for importance that improves over time without explicit user curation
- Restricting Builder/Agent access prevents memory pollution from transient task-specific observations

**Alternatives considered:**
- **SQLite** — more powerful queries, but adds a binary dependency and makes the state opaque to humans
- **Vector embeddings** — better semantic search, but requires an embedding model (API calls or local model). Can layer on later if keyword search proves insufficient
- **OpenClaw's tiered consolidation (light/deep/REM)** — compelling for large memory stores, but overkill for V1. Revisit when entry count grows past hundreds

**Consequences:**
- Search quality is limited to keyword matching — semantically similar but differently-worded queries may miss relevant entries
- No automatic memory consolidation or pruning — the store grows unbounded. Acceptable for V1 scale.
- File-per-entry means listing all memories requires reading the directory — fine up to thousands of entries
