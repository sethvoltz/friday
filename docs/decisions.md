# Architecture Decision Records

## ADR-001 — SQLite + WAL, not Postgres

**Status:** accepted

Single-user system (multi-device). Workload is sub-millisecond commits at tens of writes/sec at peak. Postgres requires a separate service that fights the local-first model. SQLite WAL handles the multi-process write contention — daemon, dashboard server proc, CLI inspections — without contention in practice. `busy_timeout=5000` mops up the rare collisions. One-file backup, content-addressed branch-isolation if we ever need it.

## ADR-002 — Daemon owns the Claude SDK; dashboard is auth + UI proxy

**Status:** accepted

Single SDK runtime keeps long-lived sessions, agent registry, fork pool, file watchers, and the EventBus all in one process. SvelteKit hot-reloads don't kill conversations. Auth boundary is clean: daemon binds to `127.0.0.1`, dashboard is the only public surface, CFT exposes only the dashboard.

## ADR-003 — Single SSE channel, NDJSON via SSE framing

**Status:** accepted

`EventSource('/api/events')` is the only persistent connection from the browser. Per-turn POST returns `{turn_id}` immediately; turn events flow on the same SSE channel tagged by `turn_id`. Native `Last-Event-ID` reconnect against the daemon's 200-event ring buffer.

## ADR-004 — DB write before SSE emit, with `last_event_seq` cursor

**Status:** accepted (refined 2026-05-12, FIX_FORWARD 8.2)

Each event has a monotonic `seq`. The block row is updated to `last_event_seq = N` *before* the event with that seq is broadcast. Browsers on focus switch / reconnect can read DB up to cursor K and live-render only events with `seq > K`. No double-application, no missed events.

**Per-block granularity (WS-1).** The invariant now holds at the *block* row level, not the turn level. Each row in the `blocks` table — one per content block (text / thinking / tool_use / tool_result / user / mail) — carries its own `last_event_seq`. Streaming deltas advance the row before the corresponding `block_delta` SSE event is emitted; `block_stop` flips `streaming = 0` after the row is final. This means a refresh mid-turn lands on exactly the bytes the live stream had: there's nothing to reconcile because there's no separate per-turn "canonical" representation.

**boot_id cursor reset.** SSE consumers cache `lastSeqByAgent`, which keeps them caught up across reconnects within a single daemon lifetime. Across a daemon restart, sequence numbers reset to 1 — a cached cursor of 500 would silently skip half the post-restart events. The daemon now generates a fresh `boot_id` on startup and stamps it on every `connection_established` SSE frame. Clients compare boot_ids on reconnect: a mismatch invalidates the cached cursor and triggers a full reload from the DB. Sequences stay simple integers, but cross-restart correctness is preserved.

## ADR-005 — Three-layer prompt stack: CONSTITUTION / SOUL / agent base

**Status:** accepted

`CONSTITUTION.md` is source-only, inviolate, prepended to every agent's system prompt. `SOUL.md` is the user's one override slot, copied to `~/.friday/SOUL.md` on first boot and never overwritten on upgrade. `agents/<type>.md` are role-specific bases, source-only. Protocols stack on top per agent. Skills inject per-turn. Memory auto-recall prepends to the user message.

## ADR-006 — Tickets table is system-agnostic; external systems join via `ticket_external_links`

**Status:** accepted

`tickets` doesn't know about Linear, GitHub, or any specific system. `ticket_external_links` carries `(ticket_id, system, external_id, url)` with the composite index `(system, external_id)`. Adding a new ticket integration is a sibling package, not a schema change.

## ADR-007 — Attachments dedup by DB row + sha-bucket disk path

**Status:** accepted

`attachments.sha256` is the PK. Upload flow: hash bytes → DB lookup by sha256 → reuse row if hit (re-write file on disk if missing). Storage path is `~/.friday/uploads/<sha-bucket>/<sha>.<ext>` where bucket is the first two hex chars (256 buckets) — content-addressed, time-independent.

## ADR-008 — No public sign-up, ever

**Status:** accepted

Single-user system. `friday setup` is the only path to create the primary account. The dashboard's `/api/auth/sign-up` endpoint is permanently disabled (`disableSignUp: true` in BetterAuth). Recovery via `friday setup --reset-password` on the host. No email-recovery, no SMS — recovery is "you have shell access where Friday lives."

## ADR-009 — Tmux-backed daemon supervision

**Status:** accepted

`friday start` launches daemon and dashboard inside a tmux session named `friday`. `friday stop` kills the session. `friday attach` opens the panes for live debugging. No launchd or systemd to configure. Restart-on-crash via tmux + a small wrapper.

## ADR-010 — `/scratch` spawns Bare agents, not Helpers

**Status:** accepted

User-spawned ad-hoc sessions use the existing Bare agent type. Bares already exist in the system as interactive-but-headless agents (used for evolve enrichment, etc.). Promoting them to first-class chat citizens avoids duplicating Helper's purpose. Helpers remain orchestrator-spawned for scoped sub-tasks.

## ADR-011 — Daemon binds one port for HTTP + SSE

**Status:** accepted

The early plan called for two daemon ports (HTTP API + SSE) — a holdover from the old Slack-era event server. SSE is just a long-lived HTTP response; there's no operational reason to split. One port keeps `friday doctor`, port-conflict diagnostics, and the dashboard's reverse proxy simpler. The dashboard's `/api/events` proxies to the same `daemonPort` everything else hits.

## ADR-012 — JSONL is boot-recovery only; the daemon writes blocks directly from worker IPC

**Status:** accepted (revised 2026-05-12, FIX_FORWARD 8.1; supersedes the original tail-watcher design)

The Claude Agent SDK still writes session transcripts to `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, but those files are **no longer tail-watched for live data**. The daemon receives block-level streaming directly from each worker over its IPC channel — `block-start` / `block-delta` / `block-stop` messages — and writes the `blocks` table itself. SSE consumers read from the same table, so what an in-progress page sees is byte-for-byte what a refresh would see after the turn completes.

JSONL retention purpose:

- **Boot-time recovery.** On daemon restart, `services/daemon/src/agent/jsonl-recovery.ts` walks each session's JSONL once and back-fills any blocks that should exist but don't (worker crashed between `block-stop` and DB write, or the daemon crashed mid-emit). Idempotent on `block_id`.
- **Compaction / off-line analysis.** Tools that want a frozen, append-only audit trail still have one.

The original design tried to surface in-flight text by writing streaming preview rows at `turn_index = 0` in the `turns` table; that was abandoned in favor of SSE deltas. The `turns` table itself was superseded by `blocks` in the WS-1 schema refactor — see the ADR on the block model for the full rationale.

## ADR-013 — `agents.json` and per-channel session files removed; SQLite is the registry

**Status:** accepted

The old Friday tracked agents in `~/.friday/agents.json` and per-Slack-channel session metadata in JSON files under `~/.friday/sessions/`. The new system collapses both into the `agents` SQLite table. Single writer (the daemon), atomic updates, queryable, indexed. Boot recovery scans the table; no more JSON-rewrite races.

## ADR-014 — Mail bus event names: `mail:to:<agent>` + `mail:any`

**Status:** accepted

The shared `mailBus` EventEmitter (`packages/shared/src/services/mail.ts`) emits two events on every `sendMail()` call: a per-recipient `mail:to:<agentName>` for direct subscription, and a generic `mail:any` for spectator subscribers (the daemon's mail-bridge re-publishes both as SSE `mail_delivered` and IPC `mail-wakeup`). Event-name collisions are prevented by the agent-name regex (`/^[a-z0-9][a-z0-9-]{0,62}$/`).

**Priority mail (amended 2026-05-12, FIX_FORWARD 8.4).** The `mail.priority` field gates *when* the recipient sees the message:

- `'normal'` (default): mail is queued and re-injected at the **next turn boundary**, matching the original ADR-014 behavior. The receiving worker finishes whatever it's doing, then receives the queued items in its next turn.
- `'critical'`: the daemon emits an IPC `mail-wakeup-critical` on delivery. Workers check for pending critical mail at every SDK iteration boundary inside a turn and break out early, so the next iteration sees the message even mid-turn. Use sparingly — interrupting tool loops costs work in flight.

Mid-turn injection is opt-in per send; the bus event names and the SSE `mail_delivered` shape are unchanged.

## ADR-015 — BetterAuth tables in our Drizzle schema, BetterAuth owns its migrations

**Status:** accepted

`accounts`, `sessions`, `users`, `verification` are declared in `schema.ts` for typed access from the rest of the app, but BetterAuth's CLI (`@better-auth/cli`) handles the actual table creation. Field names match BetterAuth's defaults. If they ever drift, BetterAuth's runtime wins and we update our typed declarations to match.

## ADR-016 — `blocks` table replaces `turns`; live in-flight state lives in daemon memory

**Status:** accepted (2026-05-12, FIX_FORWARD 8.3; supersedes the granularity portion of ADR-012 / ADR-004)

The `turns` table modeled one row per turn, with the entire content array serialized as JSON inside it. That worked for post-hoc rendering but coupled the two distinct concerns — *what eventually lands in the transcript* and *what's currently streaming* — into the same row. Live updates required either rewriting the JSON blob on every delta (expensive, race-prone) or living with the lie that the in-flight UI was extrapolating from SSE events with no DB-side ground truth.

**The new model:**

- **`blocks` table.** One row per content block (kinds: `text`, `thinking`, `tool_use`, `tool_result`, `user`, `mail`). Stable UUID `block_id` is the primary key. Block rows carry their own `seq` cursor, `streaming` flag, and source enum (`worker` for live streaming, `jsonl` for boot recovery). Per-block `last_event_seq` makes SSE cursoring trivial — see ADR-004's amendment.
- **In-memory `liveTurns` registry.** Buffers in-flight block state (deltas, partial JSON, tool-use args being assembled) inside the daemon process, keyed by `turn_id`. Crashes lose only the in-flight buffer; the persisted block rows are unaffected.
- **JSONL is boot-recovery only.** Per ADR-012's revision, the daemon writes block rows directly from worker IPC. JSONL exists so a crashed mid-block can be re-derived on restart and so an audit trail survives outside the DB.
- **FTS5.** `blocks_fts` provides full-text search across the content column. Triggers (`blocks_fts_ai/ad/au`) keep it in sync — see WS-5.1.

What this buys:

- Refresh-during-stream returns identical bytes to what the live view had — there's only one source of truth.
- Per-content-block addressability for `/jump`, deep links, and "scroll-to" affordances.
- Tool-result expansion doesn't require parsing a serialized JSON array.
- FTS5 search across exactly the granularity the user reasons about.

The old `turns` table is retained for read-side compatibility during the migration window but is no longer written; user data is migrated by a one-shot script under `scripts/` that's run once by the operator and discarded.

## ADR-017 — `chat_reply` MCP tool and `/api/chat/reply` removed; mail is the universal delivery primitive

**Status:** accepted (2026-05-12, FIX_FORWARD 8.5; supersedes the original chat-vs-mail split)

The earlier system had two parallel delivery primitives:

- **`chat_reply`** — orchestrator-only MCP tool that wrote a user-visible reply directly to the dashboard chat. Bypassed the mail bus.
- **`mail_send`** — universal inter-agent messaging. Triggered the IPC `mail-wakeup` for the receiving worker.

That split forced every site that wanted to "say something to the user" to pick a side, and the dashboard had to reconcile two streams with subtly different shapes (chat-reply rows were authoritative; mail rows landed via the bridge). It also blocked builders/helpers from speaking to the user except through the orchestrator's `chat_reply`.

**The new model:** `chat_reply` and `/api/chat/reply` are removed. All user-visible deliveries go through `mail_send` with the recipient set to `'friday'` (the orchestrator's mail box). The orchestrator's mail-bridge surfaces those messages as block rows (kind `mail`) in the chat. Builders and helpers can address the user the same way — they `mail_send` to `friday`, and the orchestrator decides whether to forward, summarize, or hold.

Consequences:

- One delivery primitive, one set of semantics, one place to instrument.
- Builders' progress reports land in the chat without orchestrator stitching.
- The `priority` field on mail (per ADR-014's amendment) gives senders mid-turn interruption when it matters.

## ADR-018 — Connectivity-chain widget replaces Bot/Live status dots

**Status:** accepted (2026-05-12, FIX_FORWARD 8.6)

The old header had two indicator dots — "Bot" (is the agent alive?) and "Live" (is SSE streaming?) — that turned out to under-communicate the failure mode in the most common outage: the *browser* lost connectivity. The dots stayed colored based on stale daemon state, and the user spent a minute confused about why nothing was updating.

**The new model:** a connectivity-chain widget with three sequential stages, each rendered as a small dot:

1. **Internet** — is the browser online? (`navigator.onLine` + lightweight ping.)
2. **SSE** — is `/api/events` connected and seen a frame in the last keepalive window?
3. **Daemon** — is the daemon reachable from the dashboard server (via `/api/health`)?

Rules:

- Each stage has its own ok / warn / error state derived from observed signals (no derived "Bot alive" inference).
- **Grey cascade:** if an upstream stage is in error, downstream stages render grey ("unknown because upstream is down") rather than red. We can't probe SSE health while Internet is dead; lying about it would be worse than admitting the cascade.
- **Tooltips are informational only.** Hovering reveals the last error, last successful sample timestamp, and the action the user can take ("check your wifi", "see daemon logs"). No clickable mitigations — this is a status surface, not a control plane.

Implementation: `services/dashboard/src/lib/components/Connectivity/ConnectivityWidget.svelte`. The fetch-based SSE client (WS-3) feeds it the SSE stage; an in-page periodic `/api/health` poll feeds the Daemon stage.

## Watch list

Open architectural questions deferred to v1.x or v2. Not yet ADRs because the trigger to decide hasn't fired.

- **Streaming Bash stdout in chat** vs. the current "summary + DB-fetch on expand" model. Watch how it feels in practice; revisit if tool-result expansion becomes a high-frequency action.
- **Memory-pressure auto-action.** Currently alert-only. If runaway workers become a recurring problem, consider auto-pause (not auto-kill) at threshold.
- **Multi-chat / scratch-chat archival.** Single persistent chat is the v1 design; `agent_name` on `turns` already supports multi-chat as a UI addition.
- **At-rest encryption for `~/.friday/`.** v1 relies on FileVault/BitLocker on the host. Native encryption can layer on later.
- **Other ticket integrations.** GH Issues, Jira, Linear-Cycles all slot into `ticket_external_links` cleanly (per ADR-006); no schema change required.
- **Mail thread/subject metadata.** Old Friday's mail had a `subject` separate from `body`. New schema only has `body` + `type`. If thread-grouping bites, add `subject text` and `thread_id text` columns + a migration.
