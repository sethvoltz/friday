# Agent Friday

## Project

A local-first Slack-to-Claude-Code bridge with a multi-agent orchestration system. See `docs/` for full documentation.

## Documentation

This project has living documentation that must stay current with the code:

- `docs/architecture.md` — System overview, components, message flow, state layout, service lifecycle, logging, agent hierarchy, testing
- `docs/decisions.md` — Architecture Decision Records (ADRs); see ADR-020 for SQLite + Drizzle, ADR-024 for the tmux-backed daemonization model
- `docs/configure-friday.md` — Config file reference
- `docs/setup-friday.md` — Setup guide
- `docs/running.md` — How to run the daemon and services (commands, modes, status JSON contract)
- `.claude/rules/drizzle-migrations.md` — Rules for evolving the DB schema

**When you make changes**, update the relevant docs. If you add a module, update the architecture table. If you change message flow, update the flow diagrams. If you make an architectural decision, add an ADR. If you add a test file, update the testing coverage table. Documentation that drifts from the code is worse than no documentation.

## Design Principles

- **Preserve over delete.** Default to keeping data (logs, state, chat messages) rather than removing it. Patch and update rather than delete. Exceptions are fine case-by-case, but the default is always preserve.
- **Workspace containment.** Builders work exclusively in their assigned worktrees. The orchestrator never touches a Builder's workspace. Agents stay in their assigned directory.
- **User approval gates.** The orchestrator confirms plans with the user before creating Builders. Builders push and open a PR automatically upon completing work.
- **Static imports only.** No inline `require()` or dynamic `import()` inside function bodies — tests excepted. The shared package ships as ESM (`"type": "module"`), so an inline `require("node:fs")` throws `ReferenceError: require is not defined` and the surrounding `try/catch` silently turns the failure into a `null`/no-op. If you need a Node API, import it at the top of the file.

## Structure

```
packages/shared    — Shared types, config, structured logger, DB layer
packages/cli       — CLI (@friday/cli) — service lifecycle, status, logs, attach
packages/memory    — File-based memory store + DB-backed FTS5 index
packages/evolve    — Self-improvement pipeline (scan → propose → rank → apply)
services/friday    — Bridge daemon
services/dashboard — Management GUI (SvelteKit, adapter-node)
docs/              — Documentation
```

## Development

```bash
pnpm install                    # Install deps
pnpm test                       # Full test suite (via Turborepo)
pnpm --filter @friday/daemon exec vitest run src/path/to/file.test.ts  # Single test
```

- TypeScript throughout, Vitest for tests, pnpm workspaces + Turborepo
- Tests are co-located with source as `*.test.ts`
- All state lives in `~/.friday/` — never hardcode paths, use constants from `@friday/shared`
- **`@friday/shared` is consumed via its built `dist/` (see `packages/shared/package.json` `exports`).** When you edit shared source, run `pnpm --filter @friday/shared build` before exercising the change in the daemon or dashboard — vitest reads source directly so tests will pass even when consumers still see the stale dist.

## Versioning

Single system version in the root `package.json`. All packages ship together — no per-package versioning. Bump the version when tagging a release on `main`.

## Branching

- `main` is the stable branch. All work happens on feature branches.
- Merge feature branches into `main` via squash merge or regular merge.
- Tag releases on `main` as `vX.Y.Z`.

## Commits

All commits **must** follow [Conventional Commits](https://www.conventionalcommits.org/). The scope is the service, package, or tool being changed:

```
feat(daemon): add mail polling on agent idle
fix(dashboard): correct token breakdown calculation
refactor(shared): extract transcript parser into its own module
test(cli): add coverage for restart command
docs: update architecture table
chore: bump dependencies
```

**Scopes:** `daemon`, `dashboard`, `shared`, `cli`, `memory`, `database`, `docs`, `ci`. Use `system` for cross-cutting changes that touch multiple packages in a single commit.

**Subject line rules:**
- Lowercase, imperative mood, no trailing period
- Under 72 characters
- Body explains *why*, not *what* (the diff shows what)

Co-author lines are added automatically — do not omit them.
