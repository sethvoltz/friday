# Roadmap

Open work, sequenced for execution. This file is a working punch list — items get deleted as they ship. Architectural decisions live in `docs/decisions.md` (ADRs); user-facing usage lives in `docs/architecture.md`, `docs/chat-ux.md`, `docs/mobile-ux.md`, `docs/mcp.md`, and `docs/schema.md`.

## Status snapshot

Already shipped (do not re-touch):

- MCP foundation + agent multi-process subsystem (mail/chat/agents/memory/tickets/schedule/evolve servers; long-lived worker loop; mail-bridge spawn-on-mail; scheduled fork-and-exit with state.md/last-run.md continuity; stall watchdog with optional refork; per-agent abort).
- HEIC → PNG via sharp at upload.
- CLI `friday tickets create` interactive clack flow.
- PWA placeholder icons + regen script.
- Builder workspace path-guard hook.
- `agent_inspect` markdown formatting.
- `/reset-context` real wiring.
- Skill body injection on `/<skill>` invocation.
- Auto-memory disable + `friday-memory` MCP server.
- Evolve store + MCP foundation (markdown CRUD, apply→ticket).

What's left, in execution order below.

---

## Phase 1 — Quick wins (an afternoon, no external deps)

Three small items that close obvious user-visible cracks. Land in one batch.

### 1.1 Daemon `/restart` — stop relying on tmux

**Where.** `services/daemon/src/api/server.ts:852` — currently `setTimeout(() => process.kill(process.pid, "SIGTERM"), 100)` and assumes a tmux supervisor will respawn.

**Problem.** Works for `friday start` (tmux-supervised). Breaks anyone running outside tmux — for example via the `docs/run/com.friday.daemon.plist.example` (launchd) or `docs/run/friday.service.example` (systemd) units we ship. Those supervisors *will* respawn the daemon, so the bug is narrower than it looks: SIGTERM-and-let-supervisor-restart is fine; the comment claiming it's tmux-specific is the lie. **Fix is documentation, not code.** Update the comment to reflect that any process supervisor (tmux, launchd, systemd) is sufficient and the restart endpoint is a no-op outside one. Optionally check that we're under a known supervisor before allowing the call; bail with `503` otherwise.

**Effort.** Trivial.

### 1.2 Scheduled meta-agent task prompts reference real tools

**Where.** `services/daemon/src/scheduler/scheduler.ts:217, 230` — the seeded `scheduled-meta-daily` and `scheduled-meta-weekly` schedules carry `taskPrompt: "Run friday evolve scan, then enrich, then list."` That refers to placeholder CLI subcommands (item 1.3). Even when the CLI subcommands ship, the meta-agent itself is a forked Claude worker — it should call the **`evolve_*` MCP tools** directly, not shell out to the CLI.

**Fix.** Rewrite both `taskPrompt`s to call `evolve_save` / `evolve_list` / `evolve_apply` against signals the agent gathers itself. (Until the auto-scan pipeline lands in Phase 4, the meta-agent's job is degenerate — list open proposals, summarize, mail orchestrator about anything `severity: critical`. That's still useful.)

**Effort.** Trivial.

### 1.3 Evolve CLI subcommands

**Where.** `packages/cli/src/commands/evolve.ts:7-37` — `scan`, `enrich`, `cluster`, `list`, `show` all print `"(phase 6: full evolve pipeline lands here)"`.

**Fix.** Until Phase 4 (the actual pipeline lift), wire `list` and `show` against the existing `@friday/evolve` store so users can at least browse manually-saved proposals from the CLI. `scan`, `enrich`, `cluster` keep the placeholder until Phase 4 — but with a clearer message pointing to the orchestrator's `evolve_save` / `evolve_apply` MCP tools as the current path.

**Effort.** Small.

### 1.4 Dashboard `/evolve` empty-state copy

**Where.** `services/dashboard/src/routes/evolve/+page.svelte:35` — message says "lands in v1.x" but the store + MCP have shipped.

**Fix.** Replace with "No proposals yet. Use `evolve_save` from the orchestrator chat to capture an improvement, or wait for the meta-agent's daily scan." (The latter half lights up after Phase 4.)

**Effort.** Trivial.

---

## Phase 2 — Markdown plugins (KaTeX + Mermaid)

### 2.1 KaTeX

**Where.** `packages/shared/src/markdown/plugins.ts:21` (currently throws). Dashboard markdown renderer wherever it's invoked.

**Fix.**
- `pnpm --filter @friday/shared add katex marked-katex-extension`
- Replace `registerKaTeXPlugin()` with the marked extension registration.
- Add KaTeX CSS link to dashboard layout.
- Behind a config toggle: `config.markdown.katex` (default true; off means skip the registration).

### 2.2 Mermaid

**Where.** `packages/shared/src/markdown/plugins.ts:26`. Heavier than KaTeX — bundle size matters.

**Fix.**
- `pnpm --filter @friday/dashboard add mermaid` (dashboard-side only).
- Shared package just registers a marker that turns ` ```mermaid` blocks into a placeholder `<div data-mermaid>...</div>`.
- Dashboard component does dynamic `import("mermaid")` only when at least one mermaid block is on screen, then renders into the div.
- Behind `config.markdown.mermaid` (default true).

**Verify.** Type `$\sin(x)$` → renders. Paste a ` ```mermaid` graph → renders.

**Effort.** Medium (Mermaid is the long pole due to bundle handling).

---

## Phase 3 — Linear `reconcile()`

### 3.1 GraphQL client + reconcile pass

**Where.** `packages/integrations/linear/src/index.ts:18-22` — empty body. The boot path already calls `reconcileLinear()`.

**Fix.**
- New `packages/integrations/linear/src/api.ts` — minimal GraphQL client. Reuses `LINEAR_API_KEY` env var.
- Real `reconcile()`:
  1. Probe `LINEAR_API_KEY`. Bail early if absent (current behavior).
  2. Paginate `issues(filter: { state: { type: { in: [started, unstarted] } } })`.
  3. Cross-reference with `ticket_external_links WHERE system='linear'`.
  4. Orphans (Linear ticket, no Friday ticket): emit `system_banner` SSE event with count + a few titles.
  5. Stale (Friday ticket → Linear ticket now closed): patch the Friday ticket status. Don't delete.
- New MCP tool `linear_import({ linearId })` for orchestrator on-demand import.

**Verify.** With `LINEAR_API_KEY` set, restart daemon → reconcile pass logs orphan/stale counts. Create a Linear ticket externally; restart → `system_banner` fires. `linear_import` brings it into Friday tickets.

**Effort.** Medium. GraphQL schema is the time-sink; once typed, the loop is straightforward.

---

## Phase 4 — Evolve scan/enrich/cluster/apply pipeline

The largest remaining lift. Ports from the old `~/Development/Seth/SlackAgents/agent-friday/packages/evolve/src/` (~5,000 LOC across `scan.ts`, `scan-friction.ts`, `enrich.ts`, `clusters.ts`, `propose.ts`, `rank.ts`, `runs.ts`, `llm.ts`, `apply.ts`, `dispatch.ts`).

### 4.1 Audit + plan the lift

Before any code: enumerate what the old pipeline depends on that doesn't exist in the new shared (`DAEMON_LOG_PATH`, `USAGE_LOG_PATH`, `getAllUsageEntries`, `AGENTS_PATH`, `AgentRegistry`, …). Some are obsolete (beads `dispatch.ts`); some need ports.

### 4.2 Port `scan.ts` + `scan-friction.ts`

Walk the daemon log + usage entries. Emit one `Signal` per (event, agent) pair with severity / count / first-seen / last-seen. Self-exclusion: skip `scheduled-meta-*` agents.

### 4.3 Port `propose.ts`, `rank.ts`, `clusters.ts`

Bridge signals → proposals. Score by severity × frequency × blast radius. Cluster near-duplicates.

### 4.4 Port `enrich.ts` + `llm.ts`

LLM-driven proposal body rewrite. Used by the scheduled meta-agent.

### 4.5 Port `apply.ts` (with new dispatch)

Replace the old beads-based `dispatch.ts` with `@friday/shared/services/tickets`: `applyProposal()` creates a linked ticket and marks the proposal `applied`. (The MCP `evolve_apply` already does this — `apply.ts` is the programmatic path used by the scheduled meta-agent.)

### 4.6 New MCP tools

Extend `services/daemon/src/mcp/evolve.ts` with `evolve_scan`, `evolve_enrich`, `evolve_cluster` (orchestrator only — manual triggers).

### 4.7 Wire the meta-agent task prompts (replaces 1.2)

Once the pipeline exists, rewrite `scheduled-meta-daily` to actually run scan → enrich → cluster end-to-end via the new MCP tools. Weekly does the same with a 7-day window.

### 4.8 CLI subcommands (replaces 1.3 partial fix)

Replace `friday evolve scan/enrich/cluster` placeholders with real implementations that hit the daemon's HTTP endpoints.

**Verify.**
- Drop `~/.friday/evolve/proposals/test.md` manually → `GET /api/evolve/proposals` returns it; `/evolve` page renders it (already works after E.1).
- Force-fire `scheduled-meta-daily` via `POST /api/schedules/scheduled-meta-daily/trigger` → real scan runs; new proposals on disk; `evolve_critical` SSE fires for any `severity: critical`.

**Effort.** Medium-large; likely a multi-session port. Best done after Phase 1 quick wins land so the scheduled meta-agent isn't sitting on broken prompts.

---

## Phase 5 — Dashboard polish (virtualized chat)

### 5.1 Virtualized chat

**Where.** `services/dashboard/src/lib/components/Chat/ChatMessages.svelte` — currently full-array render. Backend already supports pagination via `?beforeId=&limit=`.

**Fix.**
- Top + bottom `IntersectionObserver` sentinels.
- Window the rendered range to ~200 messages.
- Track `isAtBottom`; auto-pin only when at the bottom.
- "↓ new messages" button when bottom-sentinel goes off-screen.
- Paginated turn loading via `services/dashboard/src/lib/stores/chat.svelte.ts`.

**Verify.** 500-turn chat scrolls smoothly; DOM never holds more than ~200 nodes.

**Effort.** Medium. Pure UI work.

---

## Watch list (no immediate trigger)

Tracked here for visibility; promote to a phase when usage demands it. Originally PLAN §18.

- **Streaming Bash stdout in chat** vs. the current "summary + DB-fetch on expand" model.
- **Memory-pressure auto-action.** Currently alert-only.
- **Multi-chat / scratch-chat archival.** Single chat is v1.
- **At-rest encryption for `~/.friday/`.**
- **Other ticket integrations** (GitHub Issues, Jira, Linear-Cycles).
- **Mail subject + thread metadata.** Schema migration if thread-grouping becomes a real need.

---

## Sequencing rationale

- **Phase 1 first** because all four items are < 1 hour each and remove user-visible cracks. Nothing depends on them; they can ship before any new feature.
- **Phase 2 + 3 in parallel** are both medium and independent. Pull whichever feels pressing first. KaTeX is the smaller of the two.
- **Phase 4 last among the implementations** because it's the largest port and the meta-agent prompts only get a real job once it's in place. Phase 1.2 is the temporary patch until then.
- **Phase 5 is dashboard polish** — schedule when chat performance bites or when mobile UX is the focus of a sprint.

Watch-list items don't need ordering until a trigger fires. Add to a phase when one does.
