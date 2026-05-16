# Roadmap

Open work, sequenced for execution. Items get deleted as they ship. Architectural decisions live in `docs/decisions.md` (ADRs); user-facing usage in `docs/architecture.md`, `docs/chat-ux.md`, `docs/mobile-ux.md`, `docs/mcp.md`, and `docs/schema.md`.

## Watch list (no immediate trigger)

Tracked here for visibility. Promote to a phase when usage demands it.

- **Streaming Bash stdout in chat** — vs. the current "summary + DB-fetch on expand" model. Acknowledged interesting; not now.
- **Friday Apps v2** (ADR-021 v2 column): HTTP route mounting under `/apps/<id>/*` for TRMNL-style external surfaces; dedicated dashboard route with per-app drill-down; destructive UI actions behind confirmation modals; port the existing kitchen bare agent + meal memory entries + scheduled weekly schedule onto the platform once the MVP has lived a release cycle.
- **Friday Apps v3**: capability declarations (`network[]`, `filesystem[]`, `exec[]`) backed by sandbox-exec / landlock enforcement, gated on family-visibility landing. Trust-by-discipline holds at single-user scale until that point.
- **Declarative app migrations** (`memory.retag` etc.). Defer until an app demands one; the MVP's atomic install/uninstall is enough for the foreseeable future.
