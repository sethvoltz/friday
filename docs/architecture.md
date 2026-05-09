# Friday Architecture

## Topology

```
                 Cloudflare Tunnel (public)
                           │
                           ▼
                ┌─────────────────────┐
                │  SvelteKit Dashboard │ ◄── BetterAuth (in-process)
                │   (adapter-node)     │
                └──────────┬───────────┘
                           │  localhost HTTP
                           ▼
                ┌─────────────────────┐
                │      Friday Daemon   │ ◄────► Claude API
                │   (127.0.0.1 only)   │
                │  • Claude Agent SDK  │
                │  • Agent registry    │
                │  • Forked workers    │
                │  • EventBus + SSE    │
                │  • SQLite (WAL)      │
                └──────────┬───────────┘
                           ▲
                           │  localhost HTTP
                ┌─────────────────────┐
                │     friday CLI      │
                └─────────────────────┘
```

- **Dashboard** is the only public-facing process; auth gates everything before forwarding to the daemon.
- **Daemon** is the sole runtime for the Claude SDK and the only writer of the SQLite db. Binds to `127.0.0.1`.
- **CLI** talks to the daemon directly on localhost — no auth, the OS provides the boundary (`~/.friday/` is `0700`).

## Components

| Path | Purpose |
|---|---|
| `packages/shared` | Types, config, logger, DB layer (Drizzle), wire schema, prompts, services (mail/tickets/attachments/turns), markdown plugins |
| `packages/cli` | `friday` CLI (citty + clack + picocolors) |
| `packages/memory` | File-based memory store + DB-backed FTS5 + auto-recall |
| `packages/evolve` | Self-improvement pipeline (scaffold; full pipeline lifts in v1.x) |
| `packages/integrations/linear` | Optional Linear API integration |
| `services/daemon` | Headless API. Owns SDK, agent registry, fork-per-agent workers, EventBus, SSE, scheduler |
| `services/dashboard` | SvelteKit + Svelte 5 (runes). Auth-gated public surface, proxy + UI |

## Wire protocol

- Single `EventSource('/api/events')` from the browser. Long-lived. Native `Last-Event-ID` reconnect against the daemon's ring buffer (200 events).
- `POST /api/chat/turn` returns `{turn_id}` immediately. The streaming events flow on the SSE channel tagged with that id.
- `POST /api/chat/turn/<id>/abort` is the Stop button.

Event types include: `turn_started`, `text_delta`, `tool_use_start`, `tool_use_end`, `compaction_start/end`, `error`, `turn_done`, `agent_message`, `agent_lifecycle`, `agent_status`, `mail_delivered`, `schedule_fired`, `evolve_critical`, `system_banner`. Schema in `packages/shared/src/wire/events.ts`.

## Identity / prompt stack

Every agent's system prompt is composed in this order:

1. `CONSTITUTION.md` — inviolate rules, source-only.
2. `SOUL.md` — identity, user-overridable at `~/.friday/SOUL.md`.
3. `agents/<type>.md` — role-specific behavior.
4. `protocols/*.md` — situational integration protocols.

Then per turn:

5. Skill prompt when a slash skill is invoked.
6. `<memory-context>` auto-recall block.
7. User message.

## Agent lifecycle

```
spawnTurn()
  → fork(WORKER_PATH)
  → child sends { type: "ready" }
  → parent sends { type: "start", options }
  → worker runs Claude SDK query() loop
  → worker emits text-delta, tool-start/end, compaction-start/end, turn-complete
  → parent translates each into eventBus.publish(...) and DB writes (cursor first)
  → on turn-complete the worker is asked to stop and exits
```

DB writes happen **before** SSE emit — single transaction. The `turns.last_event_seq` cursor lets browsers do race-free replay on focus switch and reconnect.

## State

| Storage | Lives at | Owns |
|---|---|---|
| SQLite (WAL) | `~/.friday/db.sqlite` | accounts/sessions/users (BetterAuth), turns, mail, tickets, ticket_relations, ticket_external_links, ticket_comments, attachments, agents, schedules, memory_entries, db_meta. FTS5 indexes on turns + memory. |
| Filesystem | `~/.friday/` | SOUL.md, skills/*.md, uploads/<sha-bucket>/<sha>.<ext>, memory/entries/*.md, evolve/proposals/*.md, workspaces/<name>/, logs/*.jsonl |
| Memory (process) | daemon | EventBus ring buffer (200 events) |

## Logs

Structured JSONL via `@friday/shared.createLogger`, rotated at 1 MiB into gzipped archives kept indefinitely. Every request to the dashboard is logged with method, path, status, duration, and userId.

## Inheritance from the old Friday

Lifted nearly verbatim:
- `@friday/memory` (store + search + events).
- Logger, transcript parser, atomic-write, cron utilities.
- Worker fork protocol (lightly extended for the new wire schema).
- EventBus + SSE pattern.
- CLI shape (citty + clack + picocolors).

Replaced:
- Slack interface — gone entirely. `chat_reply` MCP tool replaces `slack_reply`.
- Beads — replaced with the SQLite mail + tickets schema.
- Per-channel session tracking — single persistent orchestrator with sub-agents tracked in `agents`.
