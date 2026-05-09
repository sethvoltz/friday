# Friday

A local-first, headless agent daemon with a SvelteKit dashboard exposed via Cloudflare Tunnel. See `docs/` for full documentation.

## Documentation

- `docs/architecture.md` — System overview, components, message flow, prompt stack, agent hierarchy.
- `docs/decisions.md` — ADRs.
- `docs/setup.md` — Setup guide including CFT walkthrough.
- `docs/running.md` — How to run the daemon and dashboard.

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

## Versioning

Single system version in the root `package.json`. All packages ship together.

## Commits

Conventional Commits. Scopes: `daemon`, `dashboard`, `shared`, `cli`, `memory`, `evolve`, `integrations`, `docs`, `ci`. Use `system` for cross-cutting changes.
