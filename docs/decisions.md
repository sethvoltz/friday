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
