# Friday Architecture

Local-first, headless agent daemon with a SvelteKit dashboard exposed via Cloudflare Tunnel. Single user, multi-device. SQLite is the single source of truth.

## Goals

- **Headless daemon, dashboard-primary.** The daemon is a pure API tier. The dashboard is the primary interface, with a single persistent chat with Friday at `/`.
- **Local-first with public reachability.** Runs on the user's machine; reachable from anywhere via CFT. No third-party services beyond the Claude SDK and learned integrations (Linear, future GH Issues, etc.).
- **Single user, multi-device.** Phone, tablet, laptop. One identity, one chat thread, shared memory across devices.
- **Full mobile usability.** Every page is fully usable on phone and tablet — not just responsive cosmetics.
- **Markdown-first content.** System prompts, identity, skills live as markdown files, not multi-line strings in TypeScript.
- **TypeScript top-to-bottom**, ESM, strong typing, monorepo (pnpm workspaces + Turborepo).
- **SQLite-backed persistence.** Single file at `~/.friday/db.sqlite`, WAL mode.

## Non-goals (v1)

- Slack as an interface or output. (Future integration package possible; not v1.)
- Multi-tenant / multi-user identity.
- 2FA, passkey, social login. (Future BetterAuth additions.)
- Cloudflare Access edge layer, rate limiting. (Future hardening.)
- Multi-profile / per-branch boot isolation.
- Math (KaTeX) and Mermaid rendering. (Plugin slots ready; activation in v2 — see `docs/roadmap.md`.)
- Migration of old Friday's data. Greenfield means greenfield.

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
- **Daemon** is the sole runtime for the Claude Agent SDK and the only writer of the SQLite db. Binds to `127.0.0.1`.
- **CLI** talks to the daemon directly on localhost — no auth, the OS provides the boundary (`~/.friday/` is `0700`).

## Tech stack

| Concern | Choice |
|---|---|
| Language | TypeScript, ESM |
| Build | pnpm workspaces + Turborepo |
| Tests | Vitest (co-located `*.test.ts`) |
| Daemon runtime | Node.js |
| Agent runtime | Claude Agent SDK (default model: `claude-opus-4-7`) |
| Database | SQLite + WAL + Drizzle ORM |
| Dashboard framework | SvelteKit + Svelte 5 (runes) + adapter-node |
| Auth | BetterAuth (u/p only in v1; see ADR-008) |
| CLI | citty + @clack/prompts + picocolors |
| Markdown | marked + DOMPurify + Shiki (Catppuccin Latte / Mocha) |
| Image processing | sharp (HEIC → PNG, dimension caps) |
| Process supervision | tmux (see ADR-009) |

## Repo layout

```
agent-friday/
  package.json
  pnpm-workspace.yaml
  turbo.json
  tsconfig.base.json
  Brewfile
  .env.example
  CLAUDE.md
  README.md
  bin/                              # `friday` shim → packages/cli/dist/index.js
  docs/
    architecture.md
    chat-ux.md                      # single-chat UX, sidebar, slash, attachments
    mobile-ux.md                    # priority+ nav, virtualization, PWA
    mcp.md                          # MCP server surface table
    schema.md                       # DB schema overview
    decisions.md                    # ADRs
    roadmap.md                      # open work, watch list
    setup.md
    running.md
    run/                            # autostart unit examples (launchd, systemd)
  packages/
    shared/                         # @friday/shared
      src/
        config.ts
        env.ts
        log.ts
        agents.ts
        usage.ts
        transcript.ts
        atomic-write.ts
        cron.ts
        skills.ts
        wire/events.ts              # SSE event schema (TS discriminated union)
        prompts/
          CONSTITUTION.md
          agents/{orchestrator,builder,helper,scheduled,bare}.md
          protocols/linear.md
          fragments/{soul.default.md, auto-recall-header.md}
          skills/                   # built-in skills (empty in v1)
        services/                   # mail, tickets, attachments, turns, usage
        markdown/plugins.ts         # extension registry (KaTeX/Mermaid in v2)
        db/
          schema.ts                 # Drizzle
          client.ts
          migrate.ts
          drizzle/                  # generated migrations
    memory/                         # @friday/memory (file + FTS5 + auto-recall)
    evolve/                         # @friday/evolve (store + types; pipeline pending)
    cli/                            # @friday/cli, bin: friday (citty + clack)
    integrations/
      linear/                       # @friday/integrations-linear
  services/
    daemon/                         # @friday/daemon
      src/
        index.ts
        api/                        # HTTP routes + SSE
        agent/                      # lifecycle, worker, workspace, jsonl-mirror, registry, watchdog, workspace-guard
        scheduler/                  # cron tick + state.md continuity + spawn
        comms/                      # mail-bridge, mail-prompt
        events/                     # EventBus + ring buffer
        mcp/                        # friday-{mail,chat,agents,memory,tickets,schedule,evolve,echo}
        monitor/                    # health.json heartbeat
    dashboard/                      # @friday/dashboard (SvelteKit + Svelte 5 runes)
      src/
        routes/                     # /, /dashboard, /sessions, /tickets, /schedules, /memory, /evolve, /logs, /settings
        lib/                        # components, stores, hooks
      static/                       # PWA manifest + icons
      scripts/generate-icons.mjs    # regenerate PWA icons from a source SVG
```

## Components

| Path | Purpose |
|---|---|
| `packages/shared` | Types, config, logger, DB layer (Drizzle), wire schema, prompts, services (mail/tickets/attachments/turns/usage), markdown plugins, skills loader |
| `packages/cli` | `friday` CLI (citty + clack + picocolors) |
| `packages/memory` | File-based memory store + DB-backed FTS5 + auto-recall block |
| `packages/evolve` | Self-improvement proposals (store + types; full pipeline lifts in roadmap) |
| `packages/integrations/linear` | Optional Linear API integration (reconcile() pending) |
| `services/daemon` | Headless API. Owns SDK, agent registry, fork-per-agent workers, MCP servers, EventBus, SSE, scheduler, mail bridge, watchdog |
| `services/dashboard` | SvelteKit + Svelte 5 (runes). Auth-gated public surface, proxy + UI |

## Data architecture

### SQLite as single store

- One file: `~/.friday/db.sqlite`. WAL mode. `busy_timeout=5000`.
- Owned by the daemon. Dashboard reads via daemon API. CLI inspection commands open read-only when daemon is down.
- Drizzle ORM for schema + migrations. Daemon applies pending migrations at startup.
- Why not Postgres: separate service fights the local-first model and per-branch dev story; SQLite WAL handles the write contention this workload produces (see ADR-001).

Full schema reference: see `docs/schema.md`.

### File storage layout (`~/.friday/`)

```
~/.friday/
  db.sqlite                         # SQLite + WAL — source of truth
  config.json                       # settings, MCP server config
  .env                              # secrets (LINEAR_API_KEY, etc.)
  SOUL.md                           # user-overridable identity layer
  skills/*.md                       # user-additive slash skills
  uploads/<sha-bucket>/<sha>.<ext>  # content-addressed attachments (ADR-007)
  memory/
    entries/*.md                    # file-based memory bodies
    events.jsonl                    # audit log
  evolve/
    proposals/*.md
    clusters/*.md
    feedback.jsonl
    runs.jsonl
  schedules/<name>/                 # scheduled-agent state continuity
    state.md                        # agent-written
    last-run.md                     # daemon-written
  workspaces/<builder-name>/        # builder git worktrees
  logs/{daemon,dashboard}.jsonl     # rotated at 1 MiB
  health.json                       # 30s daemon heartbeat
  usage.jsonl                       # per-turn usage records
```

### Claude JSONL mirror

- The daemon tail-watches `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` for every active agent.
- Each parsed turn lands in the `turns` table within a single transaction that also bumps `last_event_seq`. The SSE event is emitted only after the DB write commits (ADR-004).
- DB is the read API. JSONL is the recovery source: on DB wipe, the daemon scans `~/.claude/projects/` and rebuilds idempotently keyed on `(session_id, turn_index)`.
- `turn_index` is the byte offset in the JSONL file (ADR-012) — monotonic by construction, unique within a session, idempotent across re-drains.
- Pagination is mandatory at the DB layer.

## Auth

- BetterAuth in the dashboard. u/p only in v1.
- 30-day sessions, no remember toggle.
- **No public sign-up, ever** (ADR-008). Account creation and password reset both flow through `friday setup` on the host.
- Daemon trusts localhost + filesystem permissions. SvelteKit server proc and CLI both qualify.

## Process model

### Daemon

- Single Node process, binds `127.0.0.1` on a single port (ADR-011) handling both HTTP and SSE.
- Owns Claude SDK, agent registry, MCP servers, EventBus + ring buffer (5000 events for SSE replay).
- Forks one worker per active agent via `child_process.fork()`. See `docs/chat-ux.md` for the agent lifecycle and worker model.
- Mail delivery is push: `sendMail()` writes the row → emits on the `mailBus` EventEmitter → mail-bridge re-emits as `mail_delivered` SSE + sends `mail-wakeup` IPC to the recipient worker (or spawns a fresh turn if the agent isn't live).
- Stall watchdog every 30s. Optional refork via `config.watchdog.refork: true`.

### Dashboard

- SvelteKit + Svelte 5 + adapter-node. Production: `node build/index.js`. Dev: `vite dev`.
- Public surface, gated by BetterAuth. Every API route checks the session before forwarding to the daemon.
- `hooks.server.ts` logs all requests + unhandled errors via `@friday/shared` logger.
- Long-lived `EventSource('/api/events')` proxies to the daemon's SSE channel.

### CLI

`friday setup`, `doctor`, `start`, `stop`, `restart`, `status`, `logs`, `attach`, plus inspection (`agents`, `sessions`, `mail`, `tickets`, `memory`) and mutation subcommands. See `docs/running.md` for the full reference.

## Wire protocol

Single SSE channel. One `EventSource('/api/events')` from the browser. Long-lived. Native `Last-Event-ID` reconnect against the daemon's ring buffer.

| Endpoint | Method | Purpose |
|---|---|---|
| `POST /api/chat/turn` | POST | Send a user message; returns `{turn_id}` immediately. Streamed events flow on `/api/events` tagged with this `turn_id`. |
| `POST /api/chat/turn/<id>/abort` | POST | Stop button — daemon calls `AbortController.abort()`. |
| `POST /api/agents/:name/abort` | POST | Per-agent abort. |
| `GET /api/events` | SSE | Single persistent stream. All events flow here. |
| Other REST | GET/POST/PATCH/DELETE | CRUD for tickets, mail, memory, evolve, agents, schedules, attachments, settings. |

### SSE event types

Every payload includes `v: 1` for forward-compat. Schema in `packages/shared/src/wire/events.ts` (TS discriminated union — single source of truth shared by daemon producer, SvelteKit proxy, browser consumer).

- `turn_started` — `{turn_id, agent, ts}`
- `text_delta` — `{turn_id, text, message_id?}`
- `tool_use_start` — `{turn_id, tool_id, tool_name, input}`
- `tool_use_input` — `{turn_id, tool_id, input}` (final input after streaming)
- `tool_use_end` — `{turn_id, tool_id, status, output?}`
- `thinking_start` / `thinking_delta` / `thinking_end`
- `compaction_start` / `compaction_end`
- `error` — `{turn_id?, code, message, recoverable}` (codes include `aborted`)
- `turn_done` — `{turn_id, status: 'complete'|'aborted'|'error', usage?}`
- `agent_message` — agent-initiated user-facing message (`chat_reply`); sidebar badge increments when target is non-focused
- `agent_lifecycle` — spawn / kill / crash / refork / complete
- `agent_status` — `{agent, status, since}` for sidebar dots
- `mail_delivered` — sidebar badges
- `schedule_fired`
- `evolve_critical`
- `system_banner` — `{level, text}`
- `:keepalive` comment line every 20s to keep CFT happy

### Race-free rendering (ADR-004)

The daemon's contract: **DB write before SSE emit, in a single transaction.** Each event has a monotonic `seq` from the EventBus. The turn's row is updated with `last_event_seq = N` *before* the SSE event with `seq=N` is broadcast.

Browser cursor pattern on focus switch:

1. Always-open `EventSource` keeps running.
2. Load DB turns for new agent (paginated). Latest may be in-flight, carries `last_event_seq = K`.
3. Live-render only events with `seq > K`. Earlier events were already applied via DB load.

Prevents both double-application and missed events under any reconnect / focus-switch scenario.

## Identity / prompt stack

Every agent's system prompt is composed in this order:

1. `CONSTITUTION.md` — inviolate rules, source-only.
2. `SOUL.md` — identity, user-overridable at `~/.friday/SOUL.md`.
3. `agents/<type>.md` — role-specific behavior.
4. `protocols/*.md` — situational integration protocols.

Then per turn:

5. Skill prompt when a slash skill is invoked (injected as `<skill-context>` block).
6. `<memory-context>` auto-recall block from `@friday/memory`.
7. User message.

See ADR-005 for the full rationale.

## Agent lifecycle

Hybrid worker model:

- **Long-lived** for orchestrator, builder, helper, bare. Worker mainLoop: run `query()` → drain mail → idle on `waitForMail` (60s timeout fallback) → repeat. Driven by user input on `/api/chat/turn` or by `mail-wakeup` IPC from the daemon's mail bridge.
- **One-shot** for scheduled. Worker fires, runs the SDK iterator, exits. State continuity across fires is handled by `<stateDir>/state.md` (agent-written) + `<stateDir>/last-run.md` (daemon-written), each capped at 64 KiB on injection.

Worker IPC (`worker-protocol.ts`):

```
spawnTurn() / dispatchTurn()
  → fork(WORKER_PATH)
  → child sends { type: "ready" }
  → parent sends { type: "start", options }
  → parent may later send { type: "prompt", options } (long-lived; user follow-up turn)
  → parent may send { type: "mail-wakeup" } when mail-bridge sees mail for this agent
  → worker emits text-delta, tool-start/end, compaction-start/end, heartbeat, turn-complete
  → parent translates each into eventBus.publish(...) and DB writes (cursor first)
  → worker exits on stop / abort / fatal error / one-shot completion
```

Parent-side queue ensures multiple `prompt` IPCs don't race in-flight events with stale `turn_id`s.

## Mail and tickets

### Mail

- All-SQLite. The `mail` table is the persistence layer. The in-process `mailBus` EventEmitter is the wakeup signal.
- Push delivery: `sendMail()` writes row → emits `mail:to:<agent>` + `mail:any` (ADR-014) → daemon's `mail-bridge` republishes as `mail_delivered` SSE and sends `mail-wakeup` IPC to the live worker, or spawns a fresh turn for an idle long-lived agent.
- Boot recovery: `replayPending()` re-emits all pending rows on startup; `recoverAgents()` drains inboxes for non-killed long-lived agents.

### Tickets

- ID format `FRI-1234` (prefix + monotonic counter from `db_meta`).
- `/tickets` page renders list + detail with comments + external links.
- External-system linking is system-agnostic (ADR-006): `ticket_external_links (ticket_id, system, external_id, url, meta)` carries Linear, GitHub, anything else as sibling rows. The `tickets` table itself doesn't know any external system exists.

## State

| Storage | Lives at | Owns |
|---|---|---|
| SQLite (WAL) | `~/.friday/db.sqlite` | accounts/sessions/users (BetterAuth), turns, mail, tickets, ticket_relations, ticket_external_links, ticket_comments, attachments, agents, schedules, memory_entries, db_meta. FTS5 indexes on turns + memory. |
| Filesystem | `~/.friday/` | SOUL.md, skills/*.md, uploads/<sha-bucket>/<sha>.<ext>, memory/entries/*.md, evolve/proposals/*.md, schedules/<name>/{state,last-run}.md, workspaces/<name>/, logs/*.jsonl |
| Memory (process) | daemon | EventBus ring buffer (5000 events) |

## Logs

Structured JSONL via `@friday/shared.createLogger`, rotated at 1 MiB into gzipped archives kept indefinitely. Every request to the dashboard is logged with method, path, status, duration, and userId.

## Inheritance from the old Friday

Lifted nearly verbatim:

- `@friday/memory` (store + search + events + auto-recall block).
- Logger, transcript parser, atomic-write, cron utilities.
- Worker fork protocol (lightly extended for the new wire schema).
- EventBus + SSE pattern.
- CLI shape (citty + clack + picocolors).
- Scheduled agent state.md / last-run.md continuity convention.
- Builder workspace path-guard hook (now wired as a Claude SDK PreToolUse callback rather than a settings.json script).

Replaced:

- Slack interface — gone entirely. `chat_reply` MCP tool replaces `slack_reply`.
- Beads — replaced with the SQLite mail + tickets schema (ADR-006, ADR-014).
- `agents.json` and per-channel session files — replaced by the `agents` SQLite table (ADR-013).

Pending lift (`docs/roadmap.md`):

- Full evolve scan/enrich/cluster/apply pipeline (only the markdown store + MCP surface have been ported so far).
- Linear `reconcile()` (interface ready; GraphQL queries pending).
