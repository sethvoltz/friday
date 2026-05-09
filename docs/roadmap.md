# Roadmap

Open work, sequenced for execution. Items get deleted as they ship. Architectural decisions live in `docs/decisions.md` (ADRs); user-facing usage in `docs/architecture.md`, `docs/chat-ux.md`, `docs/mobile-ux.md`, `docs/mcp.md`, and `docs/schema.md`.

## Open

### Markdown plugin config toggles

**Where.** `packages/shared/src/markdown/plugins.ts` + `packages/shared/src/config.ts`.

**Status.** KaTeX + Mermaid plugins ship and render. The spec called for runtime toggles `config.markdown.katex` and `config.markdown.mermaid` (default true; off skips the registration so the bundle / parse cost is opt-out). Currently the plugins always install — there's no toggle.

**Fix.** Add `markdown?: { katex?: boolean; mermaid?: boolean }` to `FridayConfig`. Pass through `getMarkedExtensions(config.markdown)` in `Markdown.svelte`. Default both true.

**Effort.** Small.

### Strict chat virtualization

**Where.** `services/dashboard/src/lib/components/Chat/ChatMessages.svelte` + `ChatShell.svelte`.

**Status.**
- ✅ Top sentinel via `IntersectionObserver` paginates older turns.
- ✅ DOM cap to 200 messages when the user is bottom-pinned.
- ✅ Jump-to-latest floating button + auto-pin.
- ⚠️ Bottom sentinel uses scroll-position math (`scrollHeight - scrollTop - clientHeight < 200`) rather than `IntersectionObserver`. Functionally equivalent for auto-pin / jump-button visibility; not strict spec.
- ⚠️ When the user scrolls up to read history, the rendered slice opens to the full `chat.messages` array — DOM is uncapped in that path. Spec verify said "DOM never holds more than ~200 nodes" regardless of scroll position.

**Fix (strict virtualization).** Anchor-tracked sliding window: track an anchor message id at top-of-viewport; render `messages.slice(anchorIdx, anchorIdx + WINDOW_SIZE)`; use spacer divs sized from measured / estimated message heights to preserve scrollHeight; advance/retreat the anchor as the user scrolls. Replace bottom scroll-math with a real bottom sentinel + `IntersectionObserver` to update `pinnedToBottom`.

**Effort.** Medium. Real virtualization is delicate around streaming text, anchor stability across SSE appends, and prepended pagination — needs careful test passes.

## Watch list (no immediate trigger)

Tracked here for visibility. Promote to a phase when usage demands it.

- **Streaming Bash stdout in chat** — vs. the current "summary + DB-fetch on expand" model. Acknowledged interesting; not now.
