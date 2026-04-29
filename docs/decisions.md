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
- Logs structured JSON to stdout and `~/.friday/daemon.jsonl`
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

---

## ADR-017: Agent Names Are Permanent and Must Be Descriptive

**Date:** 2026-04-25
**Status:** Accepted

**Context:** When agent names were allowed to be reused after destruction (e.g., `builder-blog` destroyed, then `builder-blog` recreated), agents picked generic names that collided. The orchestrator would append numbers (`builder-blog2`) which is opaque and uninformative.

**Decision:** Agent names are permanently reserved. Once a name is used — even if the agent is later destroyed — it cannot be reused. The registry rejects duplicates regardless of status. System prompts guide agents to pick descriptive, specific names in `<type>-<kebab-case-descriptor>` format.

**Rationale:**
- Forces descriptive names that communicate intent: `builder-blog-redesign-2026` vs `builder-blog`
- Eliminates ambiguity in logs, transcripts, and the registry — every name maps to exactly one agent ever
- Simplifies the registry — no need to track `formerSessionIds` across reincarnations
- The cost is minimal: kebab-case has effectively unlimited namespace

**Consequences:**
- Destroyed agents remain in the registry indefinitely. May need periodic compaction if the registry grows very large (unlikely in practice).
- Agents that fail on first run and are destroyed "waste" a name. Acceptable tradeoff.

---

## ADR-018: execFileSync Over execSync for External Commands

**Date:** 2026-04-25
**Status:** Accepted

**Context:** The mail system and workspace manager used `execSync` with string interpolation to build shell commands. Message subjects and bodies containing quotes, newlines, backticks, `$()`, or other shell metacharacters were interpreted by the shell, causing garbled or empty content.

**Decision:** All external command execution uses `execFileSync` with an args array. Never pass user-controlled content through a shell.

**Rationale:**
- `execFileSync(cmd, args)` bypasses the shell entirely — each arg is passed directly to the process as a discrete argv entry
- `execSync(string)` spawns a shell and subjects the entire string to shell interpretation
- This is a standard defense against shell injection (CWE-78)

**Consequences:**
- Slightly more verbose call sites (array of args vs template string)
- Cannot use shell features (pipes, redirects, globbing) — not needed for our use cases
- `doctor.ts` still uses `execSync` for hardcoded commands with no user input — safe but could be standardized for consistency

---

## ADR-019: Daemon Log File (JSONL)

**Date:** 2026-04-25
**Status:** Accepted

**Context:** The daemon logs structured JSON to stdout, but stdout is only captured if the process manager routes it to a file. In dev mode (`tsx watch`), logs scroll past in the terminal and are lost. Debugging agent issues after the fact requires the logs.

**Decision:** The daemon tees all log output to `~/.friday/daemon.jsonl` in addition to stdout/stderr. The file is opened once at module load (`openSync` in append mode) and written synchronously per line.

**Rationale:**
- All log output is already one JSON object per line — no format change needed
- JSONL is append-only and crash-safe (each line is a complete document)
- Sync writes are fine for the daemon's log volume (low frequency, small payloads)
- File descriptor opened once avoids per-write open/close overhead
- Consistent with the existing `usage.jsonl` pattern

**Consequences:**
- Log file grows unbounded. May need rotation or size-based truncation in the future.
- Sync writes could theoretically block the event loop on a very slow disk — negligible in practice

---

## ADR-020: SQLite + Drizzle for Opaque Operational Data

**Date:** 2026-04-26
**Status:** Accepted

**Context:** The dashboard's home page and sessions layout were each scanning `~/.friday/usage.jsonl` 2–4 times per navigation, with no shared parse — by ten messages the file had been parsed dozens of times. The same query pattern (sums, counts, min/max, group-by) repeated across loaders. Memory search (`packages/memory/src/search.ts`) read every `.md` file from disk on every query. Transcript date-range lookups did partial-file reads of `~/.claude/projects/**/<sessionId>.jsonl` per former session in the registry, on every dashboard navigation. All of this was solving aggregation/index problems with file scans.

**Decision:** Adopt SQLite (WAL mode) backed by `better-sqlite3` and the Drizzle ORM. Schema lives in `packages/shared/src/db/schema.ts`; generated migrations live in `packages/shared/drizzle/` and run on first DB open per process. Both daemon and dashboard processes open the same `~/.friday/friday.db`.

The DB stores only **opaque operational data**:
- `usage` table — replaces `usage.jsonl` (one-shot import, then renamed `.migrated-<date>`)
- `memories` table + `memories_fts` (FTS5) — derived index over `memory/entries/*.md`; `.md` is still source of truth
- `transcript_index` table — derived index over `~/.claude/projects/**/*.jsonl`; SDK files untouched
- `db_meta` — generic key/value (e.g. last reconcile timestamps)

User-editable files (`config.json`, `agents.json`, `*.md`) stay as files. The DB only mirrors them when the original is large enough that scanning hurts; the user-facing copy is always authoritative.

**Rationale:**
- WAL lets daemon and dashboard hold concurrent connections to the same file without locking ceremony.
- Drizzle gives us TypeScript-first schemas, generated migrations (no hand-rolled DDL drift), and lightweight queries with no codegen step at runtime. Both the daemon and dashboard import the same query module from `@friday/shared`.
- Aggregation queries (cost-by-agent, session date ranges, recall search) become indexed lookups instead of full-file scans.
- Memory FTS5 makes free-text search proportional to result count, not corpus size, while the `.md` file model continues to support hand-editing and `grep`.
- mtime-based reconciliation with a 60s overlap window keeps the derived indexes fresh without touching `.md` files on every recall (which would create needless file churn).
- The dashboard's `parent()`-based registry dedup (Phase 2 of this work) and `getIndexedRanges()` (Phase 3b) eliminate the read amplification.

**Consequences:**
- New native dependency (`better-sqlite3`). Acceptable — the workspace already builds native modules.
- First-boot migration from `usage.jsonl` is one-shot; the source file is renamed (not deleted) to preserve data.
- FTS5 virtual tables and triggers aren't modeled by Drizzle and live in `runMigrations()` as raw SQL (idempotent `CREATE … IF NOT EXISTS`).
- The transcript indexer must skip live sessions (sessionId in the registry) because the SDK is still appending; otherwise it could cache a stale `lastTimestamp`.
- See `.claude/rules/drizzle-migrations.md` for migration discipline future agents must follow.

## ADR-021: Fork-Based Agent Process Tree with IPC Heartbeats

**Date:** 2026-04-28
**Status:** Accepted

**Context:** The original architecture ran each Builder and Helper as an `async` loop inside the daemon process. This meant:
- A misbehaving agent could hang the whole daemon
- There was no way to kill an agent's in-flight turn without killing the daemon
- Stall detection was time-based (last activity > threshold), producing false positives during legitimate long tool calls (e.g., `npm install`)
- The user had no mid-task interrupt path from Slack

**Decision:** Replace the async-loop-per-agent model with `child_process.fork()`. Each agent runs in an isolated Node.js process supervised by the daemon.

Key design choices:
- Each worker emits IPC heartbeats (`chunk-received`, `tool-start`, `tool-end`, `mail-sent`) so the supervisor has fine-grained state without polling
- Stall detection uses 3 conditions simultaneously: `lastChunkAt` stale + `!toolCallActive` + `!waitingForMail`. A slow build with an active tool call is never flagged
- `WorkerSpawnOptions` is fully serialisable (no functions/closures) so workers can be killed and re-forked with identical config; MCP servers are reconstructed inside the worker
- Kill sequence: `agent_kill` (soft/hard), SIGTERM → 5s → SIGKILL for graceful destroy; re-fork preserves workspace + session ID
- Worker path uses `import.meta.url.endsWith(".ts")` to pick `.ts` in dev (tsx) vs `.js` in prod; `execArgv: process.execArgv` propagates the tsx loader to child processes

**Rationale:**
- Process isolation prevents agent runaway from affecting the supervisor or other agents
- IPC heartbeats provide richer signal than timestamps: a tool-active agent is never a stall, even if no text has been generated in 10 minutes
- Re-fork without workspace teardown enables the Orchestrator to restart a stuck agent mid-epic without losing work
- The `/friday kill <agent>` Slack command gives users an escape hatch for runaway agents from their phone

**Consequences:**
- Each agent now consumes an OS process slot. In practice the system runs ≤10 agents, so this is not a concern.
- Workers must reconstruct MCP servers (mail, agent-tools) internally from serialisable `WorkerSpawnOptions` — these cannot be passed via IPC.
- Orphaned child processes are possible if the daemon crashes uncleanly. On restart, `restoreActiveAgents()` spawns fresh workers, leaving the orphans to be collected by the OS when they exit naturally. No durable PID registry is maintained.
- The `spawnOptions` cache is in-memory only. If a daemon restart occurs between `killAgentByName` and `reforkAgentByName`, the refork will fail (no stored options). The workaround is `restoreActiveAgents()` on restart, which rebuilds options from the registry.

## ADR-022: Two-Tier LLM Evolve Pipeline (Haiku Breadth + Sonnet Depth)

**Date:** 2026-04-27
**Status:** Accepted

**Context:** Phase 1 evolve shipped templated proposal bodies with the placeholder "Phase 1 placeholder body. Phase 4 LLM passes will rewrite this…" — an LLM rewrite step that was promised but never built. Separately, the existing scanners (`scanDaemonLog`, `scanFeedback`, `scanUsageLog`, `scanTranscripts`) only catch *operational* pain (crashes, retry bursts, token spikes). They miss the slow drip of *trust erosion* — short user corrections like "no, I said…", "wait, why did you…", "hey, I thought we were…" — which is the single most important signal that Friday is no longer behaving as the user's right hand. Friday is positioned as the user's most-trusted assistant; the improvement loop has to listen for that erosion specifically.

**Decision:** Split LLM use across two tiers and add friction as a first-class signal dimension under the "Evolve with Intent" framing.

1. **Haiku for breadth — friction scoring.** `scan-friction.ts` walks orchestrator transcripts only (current + former session ids from `agents.json`), pairs each user turn with its prior assistant text, batches 30 turns per call, and asks Haiku to score each on a 0-5 scale plus one of `correction|confusion|repeat|reset|frustration|doubt|redirect|none`. Score ≥ 2 with a non-`none` category becomes a `friction_<category>` signal; below that is dropped. Severity tiering: 4-5 → high, 3 → medium, 2 → low. Up to 3 highest-friction evidence pointers per signal. Tool-result-only turns and `<memory-context>` blocks are filtered before scoring.
2. **Sonnet for depth — proposal enrichment.** `enrich.ts` rewrites templated proposal bodies one at a time. Each call hydrates the signal's evidence pointers (±2 lines around `pointer.line`, capped at 2000 chars), then asks Sonnet for `{body, type, blastRadius}` with sections **Signal summary** | **Root cause** | **Suggested change**. Idempotent: skips when `enrichedAt >= updatedAt` unless `--force`. The system prompt explicitly flags `friction_*` signals as trust-erosion indicators that deserve extra care (typically a memory or system-prompt edit that prevents the next instance).
3. **Both tiers use the agent SDK** (`query()` from `@anthropic-ai/claude-agent-sdk`) with `allowedTools: []` and `permissionMode: "bypassPermissions"`. This keeps Pro/Max subscription billing (ADR-003) — no `ANTHROPIC_API_KEY` required.
4. **Wired into existing meta-agents.** `scheduled-meta-daily` and `scheduled-meta-weekly` now run `scan → enrich → list` (and `cluster` for weekly). Friction scanning is failure-isolated in the CLI: a transient Haiku error returns `[]` so the rest of the scan still produces a record.

**Rationale:**
- **Two tiers, not one.** Sonnet on every transcript turn would be wasteful and slow; Haiku on every proposal body would be too shallow. Haiku grades hundreds of cheap items (turns); Sonnet writes a few dozen expensive items (proposal bodies).
- **Sentiment over regex.** A patterned regex for friction phrases ("no, I said", "wait, why") would catch the obvious cases and miss everything else. Haiku reads tone, including negative cases ("no problem" = 0). Volume is low (daily / weekly with ≤7 day windows), so the cost is bounded.
- **Idempotency is non-negotiable.** Daily scans re-run forever. Without `enrichedAt >= updatedAt` skipping, every daily pass would re-call Sonnet on every proposal. The check on `updatedAt` means freshly merged signals trigger re-enrichment naturally.
- **Friction signals belong inside the same Proposal datatype.** Same `signalHash` collapsing, same scoring, same review surface. The `key` prefix `friction_*` is the only marker the orchestrator and apply path need.
- **Self-exclusion still applies.** Friction scoring runs against the orchestrator's transcripts only; meta-agent transcripts are already excluded because their session ids aren't in the orchestrator's current/former list.

**Consequences:**
- New runtime dep on `@anthropic-ai/claude-agent-sdk` inside `@friday/evolve` (already a dep of `@friday/daemon`, so install cost is shared).
- Daily scan latency increases by the Haiku batch time (rough order: a few seconds at typical volume) plus the Sonnet enrichment time per stale proposal. This is fine on a cron-driven agent.
- Friction signals can produce noisy proposals if Haiku grades a sarcastic-but-positive turn as `correction`. The severity floor (≥ 2) and the `none` category are the main guardrails; if false-positive rate is a problem, raise the floor or add a second confirmation pass.
- Templated proposal bodies remain readable on first sight — the enrichment pass is additive, not gating. Listing/show works even before enrichment runs.
