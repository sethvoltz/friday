# Friday

A local-first, headless agent daemon with a SvelteKit dashboard exposed via Cloudflare Tunnel. See `docs/` for full documentation.

## Documentation

- `docs/architecture.md` — System overview, components, topology, wire protocol, prompt stack, agent lifecycle.
- `docs/chat-ux.md` — Single-chat UX, sidebar, focus model, slash commands, attachments, markdown rendering.
- `docs/mobile-ux.md` — Priority+ navigation, virtualization, PWA, mobile autocomplete.
- `docs/mcp.md` — MCP server surface table (Friday + user-configured).
- `docs/schema.md` — DB schema reference.
- `docs/decisions.md` — ADRs + watch list.
- `docs/roadmap.md` — Open work, sequenced for execution.
- `docs/setup.md` — Setup guide including CFT walkthrough.
- `docs/running.md` — How to run the daemon and dashboard.
- `docs/ui-conventions.md` — Cross-cutting UI patterns: `+`/`−` disclosure glyphs, agent-type icon map.

## Design Principles

- **Preserve over delete.** Default to keeping data. Patch and update rather than delete.
- **Workspace containment.** Builders work exclusively in their assigned worktrees.
- **User approval gates.** The orchestrator confirms plans with the user before creating Builders.
- **Static imports only.** No inline `require()` or dynamic `import()` inside function bodies — tests excepted.

## Structure

```
packages/shared              — Shared types, config, logger, DB layer, prompts, wire schema
packages/cli                 — friday CLI (citty + clack + picocolors)
packages/memory              — File-based memory store + DB-backed FTS5 index
packages/evolve              — Self-improvement pipeline
packages/integrations/linear — Linear API integration (optional)
services/daemon              — Headless API tier; owns Claude SDK + agent registry
services/dashboard           — SvelteKit + Svelte 5; auth-gated public surface
docs/                        — Documentation
```

## Development

```bash
pnpm install
pnpm test
pnpm --filter @friday/daemon exec vitest run src/path/to/file.test.ts
```

- TypeScript throughout, Vitest for tests, pnpm workspaces + Turborepo.
- Tests are co-located with source as `*.test.ts`.
- All state lives in `~/.friday/` (override with `FRIDAY_DATA_DIR`). Never hardcode paths; use constants from `@friday/shared`.
- `@friday/shared` is consumed via its built `dist/`. When you edit shared source, run `pnpm --filter @friday/shared build` before exercising the change in the daemon or dashboard.

## Debugging

- **Trust the user; verify the system.** Seth is a developer who speaks precisely — "I didn't click X" means he didn't click X. Investigate the system, not the user. Never offer "you probably did Y by accident" as an explanation when you can't find a code path; that's the shape of giving up dressed as a hypothesis. You may *ask* a clarifying question when you genuinely need one ("did you have another tab open?", "what did the network panel show?"), but the burden of proof sits on the code, not on his behavior.

- **Don't assume — research.** When two thorough passes through the code don't explain a symptom, stop reading the same files harder and switch tools. The answer is in the logs, the DB, the SSE stream, or temporary instrumentation — not in another round of speculation. A proposed cause without a backing log line, DB row, or network event is a *hypothesis*, not a diagnosis; flag it as such when reporting and say what evidence would confirm or kill it. Two unproductive code-reading rounds is the signal to gather evidence, not the signal to write a longer write-up.

- **Logs and canonical state live under `~/.friday/`** (override with `FRIDAY_DATA_DIR`). Path resolution is `getLogPath(service)` in `packages/shared/src/config.ts`.
  - `logs/daemon.jsonl` — every daemon event in JSONL. Useful event names to grep for: `worker.fork`, `worker.prompt.queued`, `worker.exit`, `worker.turn.stalled`, `worker.abort.force-kill`, `block.seq-skew`, `blocks.update.error`, `chat.turn.user-block.error`, `queued-block.meta-update.error`, `jsonl-recovery.post-turn.error`, `daemon.shutdown`, `daemon.ready`. `tail -F` works fine; entries are one JSON per line.
  - `logs/dashboard-<ts>-<id>.jsonl[.gz]` — per-session rotating dashboard logs.
  - `logs/tunnel.log` — cloudflared plain text (only file in this dir that isn't JSONL).
  - `db.sqlite` — canonical state for blocks, turns, agents, usage, mail, tickets. `sqlite3 ~/.friday/db.sqlite "SELECT block_id, turn_id, role, kind, status, ts, last_event_seq FROM blocks WHERE turn_id = '…' ORDER BY ts;"` settles arguments about what the daemon actually persisted vs. what the dashboard rendered — when a bubble's visual state disagrees with reality, the DB row is the source of truth and the next question is "which write path produced that status?"

## Versioning

Single system version in the root `package.json`. All packages ship together.

## Commits

Conventional Commits. Scopes: `daemon`, `dashboard`, `shared`, `cli`, `memory`, `evolve`, `integrations`, `docs`, `ci`. Use `system` for cross-cutting changes.
