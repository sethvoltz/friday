# Friday

A local-first, headless agent daemon with a SvelteKit dashboard exposed via Cloudflare Tunnel. See `docs/` for full documentation.

## Documentation

- `README.md` — Top-of-repo overview: tagline, features, quick start, CLI reference, project layout, docs index. **Public-facing.** First thing visitors read.
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

### Keeping docs and README in sync

Treat `README.md` as part of the documentation surface, not an afterthought. When work changes anything a newcomer would learn from the README — features, CLI commands, prerequisites, setup steps, project layout, `~/.friday/` contents, topology, supported integrations — update the README in the same change that updates `docs/`. Do not wait for "a docs pass later."

Specifically, before considering a task done, check whether your change touches:

- **A user-visible feature** described in the README's "Key features" section → update the matching bullet.
- **A CLI command** (added, renamed, removed, or changed flags) → update the "CLI" section *and* `docs/running.md`.
- **Setup prerequisites** (Brewfile entries, Node version, required env vars) → update "Quick start" *and* `docs/setup.md`.
- **Project structure** (new package, moved service, renamed directory) → update the "Project structure" tree *and* the structure block at the top of this CLAUDE.md.
- **`~/.friday/` layout** (new file, renamed directory) → update the `~/.friday/` block in the README *and* `docs/running.md`.
- **Topology / wire protocol** (new public process, new auth boundary) → update the topology diagram *and* `docs/architecture.md`.
- **Docs themselves** (new doc page, renamed, removed) → update the README's "Documentation" table *and* the list above in this CLAUDE.md.

A docs-only change still warrants a commit with scope `docs`. A code change that lands without its README/docs counterpart is incomplete work, not "fast iteration."

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
  src/apps/                  — Friday Apps installer + boot reconcile (ADR-021)
services/dashboard           — SvelteKit + Svelte 5; auth-gated public surface
docs/                        — Documentation
```

Installed Friday Apps live under `~/.friday/apps/<id>/` (override with `FRIDAY_DATA_DIR`). See ADR-021 and `docs/architecture.md` for the platform.

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

## Database migrations

Drizzle's SQLite migrator filters journal entries by their `when` field against `__drizzle_migrations.created_at` — **not by `idx` or filename order**. A migration whose `when` is less than the current max `created_at` in the DB is silently skipped (no error, no log). One bad `when` poisons every later migration on every machine that has already applied the bad row.

**Rules — non-negotiable:**

1. **The `when` field in `packages/shared/drizzle/meta/_journal.json` MUST be a real `Date.now()` captured at the moment the migration was generated. NEVER fabricate, round, hand-type, or copy-paste a "looks plausible" value. NEVER pick a future date.** Round numbers ending in `00000` and future-dated values are immediate red flags — both have appeared in this repo via agent-authored migrations and silently broke the chain.
2. **Prefer `drizzle-kit generate`** — it writes `Date.now()` for you and keeps the snapshot chain consistent. Run `pnpm --filter @friday/shared exec drizzle-kit generate` whenever the schema in `packages/shared/src/db/schema.ts` changes.
3. **Hand-authored migrations are allowed only for data fixes and release-boundary markers** (cases where `drizzle-kit` has no diff to emit, e.g. `UPDATE …` data backfills or `SELECT 1;` markers that pin a value to a release). When you must add a journal entry by hand: use the actual current `Date.now()` (e.g. paste the output of `node -e "console.log(Date.now())"` *at the moment you author the entry*) — never a rounded approximation, never a future value, and always strictly greater than the previous entry's `when`.
4. **`runMigrations()` asserts that journal entry count equals `__drizzle_migrations` row count** after every run and throws if they diverge. If you ever see `drizzle journal/db mismatch` at boot, do not "fix" it by deleting rows — diagnose which `when` is wrong and correct both the journal *and* the DB's `created_at`.

These rules apply to Builders and any other agent working in a worktree of this repo. If you find yourself reaching for `1779…00000`-shaped timestamps, stop.

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

Conventional Commits. Scopes: `daemon`, `dashboard`, `shared`, `cli`, `memory`, `evolve`, `integrations`, `apps`, `docs`, `ci`. Use `system` for cross-cutting changes.
