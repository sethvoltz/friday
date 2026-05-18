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

**Amendment (status: accepted):** integrations are read-only **except** for one narrow write path — terminal-status propagation when a linked agent is archived. The closer in `services/daemon/src/services/ticket-close.ts` reads `ticket_external_links` for the just-closed ticket and dispatches per-`system` to the integration's state-write helper (today: Linear's `setIssueStateByType`). The local Friday ticket remains the authoritative status source; the integration is being told, not asked. This keeps the boot-time reconcile pass and orchestrator-driven import strictly read-side, while preventing the "Friday ticket says done, Linear still says In Progress" drift that prompted this amendment.

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

## ADR-019 — Older-history prepend anchors on a rendered DOM element, with a WebKit overflow-toggle for paint commit

**Status:** accepted (2026-05-13)

When the user scrolls up to the top of the chat, an `IntersectionObserver` on a top-sentinel triggers `chat.loadOlderTurns()`, which fetches and prepends up to 50 older messages. The user should stay looking at the same content rather than jumping to the new top of the list. Getting that right turned out to involve two separate problems with two separate fixes.

**1. Scroll-anchor preservation: capture a rendered DOM element, not `scrollHeight` math.**

The intuitive approach is `scrollTop = beforeTop + (scrollHeight - beforeHeight)` — measure the height growth after prepend, shift `scrollTop` by that delta. We tried it; it's brittle. Layout-flush timing across Svelte's reactive flush, `await tick()`, `requestAnimationFrame`, and `getBoundingClientRect` interacts subtly with browser-specific reflow batching, and small subpixel discrepancies stack up across pagination rounds. Instead:

- Before triggering the load, capture the first currently-rendered bubble's `data-msg-id` and its `getBoundingClientRect().top` relative to the scroll container.
- Pass an `onPrepended` callback into `chat.loadOlderTurns()` so the anchor fix runs synchronously after the messages array is mutated (not after the artificial `MIN_LOADING_MS` spinner-hold delay).
- In the callback, `await tick()` to ensure Svelte's DOM update has flushed, find the same bubble in the new DOM by id, measure its new offset, and shift `scrollTop` by `newOffset - anchorOffset`.

No `scrollHeight` arithmetic, no rAF gap. The math operates on the actual rendered position of a concrete element.

**2. WebKit / Safari / Orion paint-deferral: wrap the `scrollTop` write in a synchronous `overflow-y: hidden` toggle.**

WebKit's scroll thread defers committing a programmatic `scrollTop` change — and painting the newly-revealed region — until either the scroll thread goes idle or the next user-originated scroll event fires. When the user fast-scrolls and pegs at the top before the load completes, the scroll thread is still "hot": our `scrollTop` write lands but the area below the previously-painted region stays blank until the user scrolls 1px to wake the compositor. DOM and layout are correct; only the GPU paint is stale. Chromium's `overflow-anchor` doesn't help — WebKit didn't ship the feature until Safari 18, and even there it's the wrong layer. Layer promotion (`transform: translate3d`, `will-change`) doesn't address the scroll-thread state at all and has its own counter-productive interactions in WebKit (react-virtualized#453).

The fix is a one-tick `overflow-y: hidden` window around the `scrollTop` write:

```ts
const prev = scroller.style.overflowY;
scroller.style.overflowY = "hidden";
scroller.scrollTop += delta;
setTimeout(() => { scroller.style.overflowY = prev; }, 0);
```

Setting `overflow-y: hidden` synchronously detaches the element from WebKit's scroll thread, forcing it to commit the pending scroll position and flush a paint of the now-non-scrollable region. The async restore (`setTimeout 0`) reattaches the scroll thread once the paint has happened. **A synchronous restore reproduces the bug** — the asynchronous tick is load-bearing; this is not a place to "clean up" by inlining. Pattern adopted from `inokawa/virtua` PR #862, originally `prud/ios-overflow-scroll-to-top`. Preserves inertial / momentum scrolling because the toggle window is one task wide and visually invisible.

Implementation lives at the call site in `services/dashboard/src/lib/components/Chat/ChatMessages.svelte` (`onPrepended` + the past-session equivalent). The CSS rule on `.chat-scroll` keeps `overflow-anchor: none` as Chromium-side belt-and-braces (free on WebKit); layer-promotion hints are deliberately *not* added.

## ADR-020 — Invariant auditor is a timer-based safety net, not the primary enforcement

**Status:** accepted (2026-05-14)

Friday hit a class of bugs where the registry's view of an agent diverged from external reality — a builder row claimed status=`working` long after its worktree directory had been deleted, mail recovery happily re-dispatched to it on every restart, the dashboard rendered a green pulsing dot on a corpse. The migration that should have converted `killed`→`archived` missed it (the buggy pre-F1-A exit handler had raced it into `idle`), boot recovery only catches drift at startup, and no inline check at `spawnTurn` validated the worktree existed before forking.

The fix we ultimately want is **inline checks at every state boundary**: validate the agent can run before `spawnTurn` forks; reject `archived → working` transitions in `registry.setStatus`; refuse to dispatch mail to an agent whose worktree is gone. Each is fast, deterministic, and tied to the exact moment the bug would manifest.

What shipped instead is a **periodic invariant auditor** (`services/daemon/src/agent/invariants.ts`) running every 60 s. Two reasons it's a timer and not (yet) inline:

1. **Some drift is external to the daemon.** A user `rm -rf`'s a worktree from a terminal; a worker is SIGKILL'd by an external process and never fires its exit handler; a future code path mutates the SQLite DB directly. For these there's no code-controlled moment to hook into. `fs.watch` on macOS is unreliable for delete events; process death without a SIGCHLD signal can't be detected synchronously. A periodic scan is the right primitive — cheap (one `listAgents()` + one `existsSync()` per builder), idempotent, bounded-latency.
2. **A consistent enforcement boundary doesn't exist yet.** `registry.setStatus` is currently free-form (any status → any status). Turning it into a state-machine gate that rejects impossible transitions is the obviously-better design but it's a larger refactor — many call sites assume permissive `setStatus`. The auditor unblocks shipping the fix without that refactor.

**Trade-offs accepted:**

- Up to 60 s latency between drift and heal. For Class B drift (external) this is fine; for Class A (code-controlled paths that should have validated inline) it's a regression vs the ideal design.
- The auditor as primary enforcement is a coarser net than inline checks. If a new state-mutation path lands without invariant enforcement, the auditor catches it within 60 s rather than at the moment of the bug — and the only signal that something is missing inline is the daemon log consistently archiving/demoting the same agent on every tick.

**Path forward (deferred, not blocked):**

If/when we harden further:
- Promote `registry.setStatus` to a state-machine gate; codify the transition table (`idle ↔ working`, `working → stalled`, `* → archived` is terminal, etc.).
- Add inline checks at `spawnTurn` / `dispatchTurn` / mail-bridge dispatch / the `/api/agents/:name/archive` handler for the agent-row-vs-filesystem invariant.
- Drop the auditor interval to 5–10 min once the inline checks carry the load; keep it as defense-in-depth for Class B.

**Implementation notes (current shape):**

- One sync pass at boot + 60 s interval thereafter.
- Each rule names its source of truth in the code comment (`existsSync(worktreePath)` for rule 1; `lifecycle.live` Map for rule 2). New rules MUST do the same — guessing whose word wins on a conflict is the #1 way these subsystems rot.
- Rule precedence: terminal states (archive) beat transient states (demote). A row that violates both rules 1 and 2 gets archived, not demoted to idle — demoting would let it slip back into mail recovery on the next boot.
- Each healed agent publishes the corresponding SSE event (`agent_lifecycle:archive` or `agent_status:idle`) so the dashboard reflects the fix within the next 30 s `/api/agents` poll.

Adding a new invariant: see the "Adding a new invariant" section in `docs/architecture.md`.

## ADR-021 — Friday Apps: folder-as-app, manifest-driven, hard memory/files split

**Status:** accepted (FRI-78, 2026-05-16)

A Friday App is a named, installable, agent-owning, MCP-extending
folder under the apps data directory. The manifest on disk
(`manifest.json`) is the source of truth; the SQLite `apps` table is
derived state we reconcile against it at boot and on every install,
uninstall, or reload. App ownership flows down to agents and
schedules through nullable `app_id` columns.

**Load-bearing decisions locked in by FRI-75's grilling:**

1. **Hard split: memory = facts, files = operational data.** The
   memory store is untouched by the apps platform. No per-app claim
   tables, no recall ranker, no `family` tag override. Apps that
   need operational state (libraries, routines, generated artifacts,
   structured config) put it in files under their own folder. Apps
   that need cross-cutting facts save memory entries normally.
   Earlier directions explored per-app memory namespacing; profiling
   real meal-app entries showed two distinct data shapes (facts vs.
   operational state) that wanted different homes. Giving apps a
   directory eliminated the namespacing problem at the source
   rather than papering over it with a ranker.

2. **Trust by discipline, not enforcement.** Apps run with daemon
   privileges. No sandboxing, no capability enforcement, no
   `commandAllowlist` in v1. Protection is: collision detection at
   install time, symmetric uninstall, audit-visible state.
   Capability enforcement arrives if/when family-visibility lands.

3. **Manifest on disk is source of truth.** A daemon boot, or any
   tool call that mutates state, reconciles. A folder that
   disappears flips its row to `status='orphaned'` — never
   auto-deleted (Constitution §1: preserve over delete).

4. **Default-safe destructive flags.** Every destructive tool defaults
   to the non-destructive behavior. Opting into folder-delete or any
   other irreversible move requires an explicit flag, with a
   description leading with the irreversibility.

5. **Stdio-only, node-only, hard-coded.** App-shipped MCP servers run
   as stdio child processes, `command: "node"`, no in-process
   loading. Python and bun expansion is post-v1.

6. **Symmetric vocab.** `install` / `uninstall`. Not `register` /
   `deregister`. Not `add` / `remove`. Tool surface, CLI surface, and
   SSE events all use install / uninstall.

7. **No HTTP route mounting (yet).** No route surface under
   `/apps/<id>/*` in v1. The dashboard surface is a single read-only
   Settings card. Mounting per-app routes is a v2 problem once we
   have an app that demands it.

**What this unlocks:** an app folder Friday or the user can author
once, install via one tool call, and Friday self-manages thereafter
— including per-app stdio MCP servers (e.g. a Mealie integration)
scoped only to that app's agents, with secrets in the app's own
`.env`.

**Deferred (not dropped):** HTTP route mounting, dedicated
dashboard routes with per-app drill-down, capability declarations,
sandbox enforcement, declarative migration system, lifecycle hooks,
cross-app explicit sharing, Python/bun MCP commands, in-process
MCP servers. Per-app memory namespacing, soft-quarantine recall
rankers, and `family`-tag overrides are removed from the design
entirely, not deferred — replaced by the hard split.

## ADR-022 — Builders and Helpers may spawn Helpers (with reason); only the orchestrator spawns Builders

**Status:** proposed (FRI-38, 2026-05-18)

Today the Builder prompt reads "Do not create new builders. Do not spawn helpers" (`packages/shared/src/prompts/agents/builder.md:8`) and the `friday-agents` MCP server is hard-gated to `callerType === "orchestrator"` (`services/daemon/src/mcp/builder.ts:84`). A Builder mid-task that needs scoped research — "what does this third-party API actually return?", "summarize this 30-file directory before I edit", "fetch and digest an upstream RFC" — has to package the question, mail the orchestrator, wait for a turn, and resume. The orchestrator then spawns the Helper anyway. The middleman adds latency, drains the orchestrator's context with sub-agent bookkeeping, and discourages sub-agents from asking for help they should be asking for. The same goes for a Helper doing genuinely large comprehensive analysis — there are real tasks (five independent dependency trees, ten files of cross-cutting refactor analysis) where parallel sub-Helpers are the right shape.

In Seth's framing: *"research aids to the agents making shit is super helpful."* And later: *"If a builder needs to do research and the context of that research isn't important but the results are: Helper. If a helper is tasked with doing really comprehensive analysis of some tricky problem: sub-Helpers. This seems obvious, we just need to codify it so it also seems obvious to the agents WHILE ALSO not creating runaway conditions. An infinite trail of helpers deeply nested helps no one."* That's the value frame **and** the failure mode the rules below have to navigate.

**Decision.** The spawn matrix is:

| Spawner | Helper | Builder |
|---|---|---|
| Orchestrator | ✅ | ✅ |
| Builder | ✅ *with reason* | ❌ |
| Helper | ✅ *with reason* | ❌ |

The hard structural rule — enforced in code at the API handler — is *only* the Builder column: **no agent other than the orchestrator can create a Builder.** Helpers spawning Helpers is allowed in code; the discipline against unjustified nesting lives in prompts, telemetry, and the evolve signal, not in a daemon-side count cap.

**Why this shape:**

1. **Containment holds for Helpers under Builders.** Helpers don't have worktrees — `services/daemon/src/api/server.ts:501` only branches on `body.type === "builder"` for `createWorkspace`; every other type starts with `workingDirectory = process.cwd()`. A Builder-spawned Helper therefore lands in the daemon's cwd, **not** in the Builder's worktree. The constitutional rule "Workspace containment for builders" is preserved by construction: the Helper has no path into the worktree, and the Builder's prompt-level "do not read, write, or modify files outside it" rule still binds the *Builder*. If a Builder passes its worktree path to a Helper as data, the Helper could read it; that's a prompt-discipline issue, not a containment break, and it's identical to the surface a Helper has today when the orchestrator hands it the same path.
2. **Helpers spawning Helpers is justified by real workload shapes.** Parallelizing five independent investigations costs roughly 5× the API spend but converges in roughly 1× the wall-clock time *and* keeps the parent Helper's context clean (each sub-Helper's verbose tool-call traffic stays in its own session). Forcing every helper-of-helper to route through the orchestrator just to be re-spawned by it is theater.
3. **Builders can't be spawned by anyone but the orchestrator.** Each Builder is a worktree + branch + push-rights surface. Letting a Builder or Helper cut another worktree turns the blast radius of a single rogue task into N rogue tasks with N branches and N PRs. The orchestrator's "user approval gate before creating Builders" (Constitution §3) exists precisely because Builders are the irreversible surface; delegating that gate to another agent defeats it. This is the **only** rule the API handler enforces unconditionally.

**Cost runaway is real but not solved with a hard cap.** Each Helper consumes its own context + API spend; a 4-deep nested fanout multiplies fast. We considered (and rejected for v1) a per-agent concurrent-helper count cap. The reason: the right number depends on the task — a Helper doing genuine 10-way parallel analysis should not be blocked by a `>=3` heuristic, and a Helper doing pointless 2-way nesting shouldn't be rewarded just for staying under the line. We instead bound runaway via prompt discipline + visibility + a feedback loop:

- **Required `reason` field on spawn from non-orchestrator agents.** The `agent_create` API handler requires a non-empty `reason: string` when the caller's registry row has `type === "builder"` or `type === "helper"`. The orchestrator's spawn calls don't need it (it spawns from user intent already in the transcript). The reason is persisted on the registry row (new nullable `spawn_reason text` column) and surfaced in the dashboard's per-agent header so a human can audit "why does this helper exist." This is **not** a soft cap — it's a justification field. The point is to make the agent type the sentence "I'm spawning a helper because…" out loud; sub-agents that struggle to produce a non-tautological reason often shouldn't be spawning in the first place.
- **Structured spawn telemetry.** Every successful spawn emits a daemon event `agent.spawn` with shape `{ parent, child, type, depth, parentChain: string[], reason, ts }` to `logs/daemon.jsonl`. `depth` is computed at registration time by walking `parentName` upward through the registry until a null parent (orchestrator). `parentChain` is the full ordered list root→leaf, capped at a sane length (e.g. 16) just to bound log line size.
- **Evolve signal, not a hard block.** If `agent.spawn` events at `depth >= 4` fire more than N times in a rolling window (threshold telemetry-driven, see open questions), the meta-agent in `packages/evolve` emits a proposal that lands in the daily digest. The orchestrator (and user) get a visibility flag — not an interrupt, not a kill. Depth 1–3 is everyday work; depth ≥ 4 is "look at this" without prejudging whether it's good or bad.

**Prompt-level antipattern, named explicitly.** Both `builder.md` and `helper.md` get a "When to spawn a Helper" section with concrete YES / NO examples and the line *"infinite trails of nested helpers help no one"* verbatim. Giving the agent that exact language makes the failure mode recognizable from inside its own reasoning. Examples:

- **YES — Builder spawning a Helper:** "Five third-party APIs return shapes I haven't seen; I'll spawn a Helper per API to digest its docs and report back a one-paragraph contract each."
- **YES — Helper spawning sub-Helpers:** "Comprehensive analysis of a 12-file refactor; I'll spawn one sub-Helper per file to summarize its surface area in parallel."
- **NO:** "I'll spawn a Helper to answer a one-line factual question I could resolve myself in 5 seconds."
- **NO:** "My sub-Helper just spawned its own sub-Helper which is going to spawn another. None of us actually needs the next layer."

**Observability.** The dashboard sidebar (`services/dashboard/src/lib/components/Sidebar/Sidebar.svelte:102`) renders a flat list with the orchestrator pinned at top; it does **not** today render explicit `parent → child` tree edges or depth indentation. With Helpers-of-Helpers allowed, depth becomes meaningful and the flat list will misrepresent the structure. Verifying the existing component handles arbitrary-depth nesting cleanly (it doesn't, based on the read of lines 102–109) is a tracked follow-up: render the hierarchy with depth indent + a small `depth: N` badge, and a "parent: <name>" affordance on every non-orchestrator row. This is a follow-up ticket, not a blocker for the daemon/prompt changes.

**Mail loop risk.** Builder ↔ Helper or Helper ↔ Helper mail can in principle loop. Mail is the existing primitive and has the usual safety guarantees (turns are queued, workers rate-limit, archive halts delivery). We rely on those plus the evolve depth signal. If real loops materialize, the lever is `agent_archive` plus tightening the depth threshold for the evolve signal.

**Implementation plan (for the follow-up builder, not this PR):**

1. **`builder.md` prompt.** Rewrite the line at `packages/shared/src/prompts/agents/builder.md:8` from `Do not create new builders. Do not spawn helpers.` to `Do not create new builders. You **may** spawn Helpers via agent_create when their results matter to you but their working context shouldn't pollute yours. Every spawn requires a non-empty reason field.` Add a new "When to spawn a Helper" subsection with the YES / NO examples above and the verbatim *"Infinite trails of nested helpers help no one."* Update the Tools list to include `agent_create` / `agent_list` / `agent_status` / `agent_inspect` / `agent_archive`. Revise the line 40 paragraph (`Do not use the built-in Task tool…`) to clarify `agent_create` is the spawn path.

2. **`helper.md` prompt.** Drop the "leaf" framing entirely. Add a parallel "When to spawn a sub-Helper" section with the same YES / NO examples scoped to Helpers, the verbatim antipattern line, and a sentence: `You may spawn sub-Helpers when a task is genuinely large and parallelizable. Every spawn requires a non-empty reason field. You may not spawn Builders.` Update line 19 (`Do not use the built-in Task tool…`) to read `mail your parent` (parent may now be a Builder or another Helper). Update the Tools list to include `agent_create` / `agent_list` / `agent_status` / `agent_inspect` / `agent_archive`.

3. **MCP allowlist.** In `services/daemon/src/mcp/builder.ts`, change the `if (opts.callerType === "orchestrator")` guard around `buildAgentsServer` (line 84) to `if (opts.callerType === "orchestrator" || opts.callerType === "builder" || opts.callerType === "helper")`. The Builder and Helper get the full `agent_*` surface including `agent_archive` so they can clean up sub-agents they spawned.

4. **`agent_create` MCP tool schema.** In `services/daemon/src/mcp/agents.ts:102-143`, add `reason: z.string().optional().describe("Why you are spawning this agent. Required when caller is a builder or helper; ignored from orchestrator.")` to the zod schema, and pass `reason: args.reason` through to the API body at line 149-157.

5. **Daemon-side guard + reason enforcement + telemetry.** In `services/daemon/src/api/server.ts` at the `POST /api/agents` handler (currently lines 469–534):
   - After parsing `body`, look up the caller's registry row by `body.parentName`. If `caller.type === "builder" || caller.type === "helper"`, require `body.type === "helper"` — reject with HTTP 403 + `{ error: "only the orchestrator can spawn builders", code: "BUILDER_SPAWN_ORCHESTRATOR_ONLY" }` when violated. (`bare`-spawned creates can stay disallowed via the existing type check.)
   - For the same non-orchestrator callers, require `typeof body.reason === "string" && body.reason.trim().length > 0`. Reject with HTTP 400 + `{ error: "reason required when spawner is not the orchestrator", code: "SPAWN_REASON_REQUIRED" }` when violated.
   - Persist `reason` on the registry row. Add a `spawnReason: string | null` field to `RegisterInput` in `services/daemon/src/agent/registry.ts:36` and a nullable `spawn_reason` column to the agents table (drizzle migration via `drizzle-kit generate` — do **not** hand-write the `when` timestamp; see the CLAUDE.md migration rules).
   - Compute `depth` and `parentChain` by walking the registry upward; cap chain length at 16. Emit `logger.log("info", "agent.spawn", { parent: body.parentName, child: body.name, type: body.type, depth, parentChain, reason: body.reason ?? null })` immediately after `registry.registerAgent(...)` succeeds.

6. **Evolve signal.** In `packages/evolve`, add a rule that scans the daily `agent.spawn` events and surfaces a proposal when `depth >= 4` occurs more than `N` times in a rolling window. Threshold value left as an open question; wire the scaffolding with `N = 5 / 24h` as a starting placeholder. No hard block — proposal only.

7. **Dashboard tree-render follow-up.** Open a separate ticket: `services/dashboard/src/lib/components/Sidebar/Sidebar.svelte` to render parent→child indentation + a depth badge for any agent whose parent is not the orchestrator. Not in scope for the FRI-38 implementation builder.

8. **Tests.** Add to `services/daemon/src/agent/` (sibling to `invariants.test.ts`):
   - Builder → Helper spawn with a reason returns 200 and registers a row with `parentName` = builder, `type` = helper, `worktreePath` = null, `spawnReason` = the reason. The corresponding `agent.spawn` log line is emitted with `depth: 2`.
   - Helper → Helper spawn with a reason returns 200 and registers `depth: 3` (orchestrator → helper → helper) on the spawn event.
   - Builder → Helper without a reason returns 400 with code `SPAWN_REASON_REQUIRED`.
   - Helper → Helper without a reason returns 400 with code `SPAWN_REASON_REQUIRED`.
   - Builder → Builder returns 403 with code `BUILDER_SPAWN_ORCHESTRATOR_ONLY`.
   - Helper → Builder returns 403 with the same code.
   - Orchestrator → Builder still succeeds with no reason field (the existing path is unchanged for orchestrator callers).
   - MCP gating: `buildMcpServers({ callerType: "builder" })` and `buildMcpServers({ callerType: "helper" })` both include `AGENTS_SERVER_NAME`.
   - The existing "builder doesn't see `agent_*`" assertion in current tests, if present, is **updated** to reflect that builders and helpers now see the surface — don't silently delete the old assertion.

**Open questions** (deliberately not decided here):

- **Evolve threshold.** What's the right depth + count combination for the evolve signal? `depth >= 4`, more than `5` events / `24h` is a starting guess. Telemetry-driven — let real `agent.spawn` data calibrate this once it's flowing.
- **`reason` format.** Free-form text vs. small enum (`research`, `parallel-analysis`, `digest`, etc.)? Free-form is more honest and harder to game; enum is more queryable. Leaning free-form for the MVP; if dashboards or evolve digests want a structured cut later, we can introduce a `kind` enum alongside the free-form field.
- **Auto-archival lineage.** When a Builder (or Helper) archives, do in-flight sub-Helpers cascade-archive, or persist? Probably cascade for `status === "working"` children and persist for `status === "idle"` already-completed children — but flag it.
- **Mail injection.** The orchestrator can already *read* Builder ↔ Helper mail via the dashboard. Should it be able to *inject* into that mailbox (e.g. interrupt a runaway nested-Helper exchange)? Today no agent can inject into another's mailbox out-of-band; the orchestrator's only lever is `agent_archive`. Leaving this open until we see whether read-only visibility plus the evolve signal is enough.

## Watch list

Open architectural questions deferred to v1.x or v2. Not yet ADRs because the trigger to decide hasn't fired.

- **Streaming Bash stdout in chat** vs. the current "summary + DB-fetch on expand" model. Watch how it feels in practice; revisit if tool-result expansion becomes a high-frequency action.
- **Memory-pressure auto-action.** Currently alert-only. If runaway workers become a recurring problem, consider auto-pause (not auto-kill) at threshold.
- **Multi-chat / scratch-chat archival.** Single persistent chat is the v1 design; `agent_name` on `turns` already supports multi-chat as a UI addition.
- **At-rest encryption for `~/.friday/`.** v1 relies on FileVault/BitLocker on the host. Native encryption can layer on later.
- **Other ticket integrations.** GH Issues, Jira, Linear-Cycles all slot into `ticket_external_links` cleanly (per ADR-006); no schema change required.
- **Mail thread/subject metadata.** Old Friday's mail had a `subject` separate from `body`. New schema only has `body` + `type`. If thread-grouping bites, add `subject text` and `thread_id text` columns + a migration.
