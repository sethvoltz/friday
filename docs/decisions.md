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

**Status:** accepted

Each event has a monotonic `seq`. The `turns` row is updated to `last_event_seq = N` *before* the event with that seq is broadcast. Browsers on focus switch / reconnect can read DB up to cursor K and live-render only events with `seq > K`. No double-application, no missed events.

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

## ADR-012 — JSONL `turn_index` is the byte offset; no streaming preview rows

**Status:** accepted

`turn_index` in the `turns` table is the absolute byte offset of the JSONL line in `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. That value is monotonic by construction, unique within a session, and re-drainable: if the daemon restarts mid-session, re-walking the file lands on the same `(session_id, turn_index)` rows and `upsertTurn` is idempotent.

An earlier plan called for streaming preview rows at `turn_index = 0` to surface in-flight text before the JSONL finalized. We did not implement it — streaming text is delivered live via SSE `text_delta` events, and the `turns` table only carries canonical post-JSONL rows. Means there's nothing to reconcile.

## ADR-013 — `agents.json` and per-channel session files removed; SQLite is the registry

**Status:** accepted

The old Friday tracked agents in `~/.friday/agents.json` and per-Slack-channel session metadata in JSON files under `~/.friday/sessions/`. The new system collapses both into the `agents` SQLite table. Single writer (the daemon), atomic updates, queryable, indexed. Boot recovery scans the table; no more JSON-rewrite races.

## ADR-014 — Mail bus event names: `mail:to:<agent>` + `mail:any`

**Status:** accepted

The shared `mailBus` EventEmitter (`packages/shared/src/services/mail.ts`) emits two events on every `sendMail()` call: a per-recipient `mail:to:<agentName>` for direct subscription, and a generic `mail:any` for spectator subscribers (the daemon's mail-bridge re-publishes both as SSE `mail_delivered` and IPC `mail-wakeup`). Event-name collisions are prevented by the agent-name regex (`/^[a-z0-9][a-z0-9-]{0,62}$/`).

## ADR-015 — BetterAuth tables in our Drizzle schema, BetterAuth owns its migrations

**Status:** accepted

`accounts`, `sessions`, `users`, `verification` are declared in `schema.ts` for typed access from the rest of the app, but BetterAuth's CLI (`@better-auth/cli`) handles the actual table creation. Field names match BetterAuth's defaults. If they ever drift, BetterAuth's runtime wins and we update our typed declarations to match.

## Watch list

Open architectural questions deferred to v1.x or v2. Not yet ADRs because the trigger to decide hasn't fired.

- **Streaming Bash stdout in chat** vs. the current "summary + DB-fetch on expand" model. Watch how it feels in practice; revisit if tool-result expansion becomes a high-frequency action.
- **Memory-pressure auto-action.** Currently alert-only. If runaway workers become a recurring problem, consider auto-pause (not auto-kill) at threshold.
- **Multi-chat / scratch-chat archival.** Single persistent chat is the v1 design; `agent_name` on `turns` already supports multi-chat as a UI addition.
- **At-rest encryption for `~/.friday/`.** v1 relies on FileVault/BitLocker on the host. Native encryption can layer on later.
- **Other ticket integrations.** GH Issues, Jira, Linear-Cycles all slot into `ticket_external_links` cleanly (per ADR-006); no schema change required.
- **Mail thread/subject metadata.** Old Friday's mail had a `subject` separate from `body`. New schema only has `body` + `type`. If thread-grouping bites, add `subject text` and `thread_id text` columns + a migration.
