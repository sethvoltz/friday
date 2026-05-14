# Chat UX

The dashboard's home `/` is a single persistent chat with Friday. This doc captures the UX shape: focus model, sidebar, slash commands, attachments, markdown rendering. Mobile-specific behaviors live in `docs/mobile-ux.md`.

## Single persistent chat

- Home `/` is *the* chat with Friday. One persistent orchestrator named "Friday" (or whatever the user names it).
- No conversation list, no "new chat" button. Memory + compaction handle long-term context.
- When the orchestrator spawns a sub-agent (builder/helper/bare), the spawning event renders inline in the orchestrator's transcript as a **clickable reference** (agent name + status badge + brief context). Clicking the reference switches the chat pane to that agent — full transcript, live streaming, all chat features.
- **No collapsible / inline expansion.** Sub-agents are first-class chats you switch into, not nested views.
- The user navigates back to Friday by clicking Friday in the sidebar (or the `Friday 👑` entry at the top), or via a back-affordance in the sub-agent's chat header.
- Today's home-page content (status overview, usage stats, daily cost chart, agents/sessions/memory/config tables) lives at **`/dashboard`** — a separate destination in the nav. Tables and charts refresh on new turns via the SSE channel.

## Sidebar

- **Friday 👑 pinned at the top** as the orchestrator entry. Always present, always first.
- Below: all other non-archived sessions (active + idle builders, helpers, bare, scheduled-mid-run) with status dots (idle / working / stalled / error) and unread badges (`agent_message` count).
- Click any entry → chat pane switches focus to that agent's transcript.
- Archived agents are hidden by default; toggle "Show archived" to surface them. Sessions persist in perpetuity — archive just stops the agent from receiving work and (for builders) frees the worktree.
- "Show inactive" surfaces the transient-error bucket: agents in `stalled` or `error` status. ("Show archived" handles the terminal bucket; `idle` and `working` always show.) The focused row is always pinned, regardless of either toggle, so the chat you're reading never falls off the sidebar when its agent flips state.

## Multi-agent focus model

- One explicit focused agent per browser session. Click is the only signal — no inferred disinterest.
- **Per-agent isolation.** The SSE store keeps a separate `lastSeqByAgent` cursor (with a `__system__` bucket for non-agent envelope events). Switching focus is local to the client: each agent has its own block list, its own cursor, and they don't bleed.
- Non-focused agents: status updates (sidebar dots), badge increment **only on `mail_delivered`** events. `block_delta` events from non-focused agents drop on the floor (still in DB).
- **Streaming fidelity = post-load fidelity.** A mid-turn refresh returns exactly the bytes the live stream had, because both sources read the same `blocks` rows. There's no separate "canonical" rendering after the turn ends — what you saw stream is what's persisted.
- Focus switch flow: paginated load of `blocks` for the new agent → resume SSE deltas where `seq > cursor` → done. A `boot_id` mismatch on `connection_established` invalidates the cursor and triggers a full reload.

## Scroll behavior

`ChatMessages.svelte` runs two `IntersectionObserver`s on sentinel divs at the top and bottom of the message list:

- **Bottom sentinel.** Sets `chat.pinnedToBottom` based on whether the bottom of the list is within 200px of the viewport. Drives the jump-to-latest pill, the auto-scroll-on-new-message effect, and the DOM-windowing slice.
- **Top sentinel.** Triggers `chat.loadOlderTurns()` when the user scrolls within 200px of the top. Fetches up to 50 older turns via `/api/agents/:name/turns?beforeId=...`, prepends them, and re-anchors the scroll so the user keeps looking at the same content rather than jumping to the new top.

**DOM windowing.** When `pinnedToBottom` is true and the list exceeds 200 messages, only the last 200 are rendered — keeps the DOM bounded for long chats. The slice is suppressed while `chat.loadingOlder` is true so a mid-mutation IntersectionObserver hiccup can't shrink the rendered set out from under the user.

**Scroll-anchor preservation on prepend.** Naive `scrollTop = beforeTop + (newScrollHeight - oldScrollHeight)` arithmetic is sensitive to layout-flush timing and dies on subpixel rounding. Instead we capture the first rendered bubble's `data-msg-id` and its `getBoundingClientRect().top` *before* triggering the load; after `await tick()` finds the same bubble in the new DOM, we shift `scrollTop` by the difference between its old and new offsets. Concrete elements, no scrollHeight math.

**WebKit / Safari / Orion paint-deferral.** Setting `scrollTop` while WebKit's scroll thread is still hot (fast-scroll just stopped, momentum still resolving) makes WebKit defer both the scroll-position commit and the paint of the newly-revealed region until the next user-originated scroll event. The DOM and layout are correct; the GPU paint is stale. Symptom: blank chat below a thin top band, fixed by any 1px scroll. We wrap the `scrollTop` write in a synchronous `overflow-y: hidden` → write → `setTimeout(0)` restore. Setting `overflow-y: hidden` detaches the element from the scroll thread, forcing WebKit to commit + paint synchronously; the async restore reattaches it once paint has happened. Synchronous restore reproduces the bug — the `setTimeout` tick is load-bearing. Pattern lifted from `inokawa/virtua` (PR #862, originally `prud/ios-overflow-scroll-to-top`). See ADR-019.

## Slash commands and skills

Two flavors, one input:

### System commands

TypeScript-defined, deterministic, no LLM:

```
/archive <agent> /restart        /status         /inspect <agent>
/reset-context   /jump <date|term>    /scratch [name]
```

System commands return immediately. `/reset-context`, `/restart` and other destructive commands gate behind a confirmation modal.

**`/jump <date|term>`** (FIX_FORWARD 6.1). Two modes:

- `/jump 2026-03-05` — date jump. Loads the block list with `around_ts` cursor centered on midnight of the requested day. Accepts `today`, `yesterday`, weekday names, `Nd ago` shorthand.
- `/jump <term>` — content jump. Runs `blocks_fts MATCH ?` against the current agent's blocks, picks the most recent match, and scrolls + highlights the target block (jump-pulse animation).

A toast pill surfaces match counts and lets the user step through additional results. Highlighting clears on next user input.

### Skills

Markdown-defined, LLM-mediated. Frontmatter:

```yaml
---
name: plan-week
description: Plan the upcoming week from calendar + active tickets
agents: [orchestrator, helper]   # restriction; omit for "all types"
allowed_tools: [tickets_search, mail_send]   # optional subset restriction
auto_invoke: true                # default true; built-ins set false
---
```

- **Built-in skills** live in `packages/shared/src/prompts/skills/*.md`. (Empty in v1; placeholder dir exists.)
- **User-additive skills** live in `~/.friday/skills/*.md`. Daemon watches both; collisions warn and the user file wins.
- Auto-invoke is essentially free via the Claude Agent SDK's skill dispatch.
- Manual invocation: typing `/<skill> args` at the start of a chat message injects the skill body as a `<skill-context>` block in the system prompt for that turn only. The remaining text becomes the user message.
- When a skill declares `allowed_tools`, the daemon assembles the SDK call with the **intersection** of the agent's normal tool set and the skill's declared tools. Per-turn, restriction-only — never expansion.

## Stop button

- Replaces Send during in-flight turns (same physical slot).
- `POST /api/chat/turn/<id>/abort` → daemon `AbortController.abort()`.
- Aborts at next SDK iteration. Tool calls already in flight finish; no next step. Honest UI copy: *Stop prevents future steps. It can't undo a step already started.*

## Chat input

- Plain text → orchestrator turn.
- `/` opens autocomplete — system commands first (badged "system"), skills second.
- **Slack-style keyboard nav** (FIX_FORWARD 6.2). With the menu open: first ArrowDown / ArrowUp transfers focus *into* the menu (the input caret stops blinking, the menu item highlights). Subsequent arrows navigate items. **Tab** or **Enter** applies the selection and returns focus to the input with the cursor at end. **Esc** closes the menu and keeps focus in the input. Enter with the menu closed submits the turn as usual.
- On mobile: tap-to-insert preserves keyboard focus. `pointerdown` + `preventDefault` on the autocomplete entry so the input never blurs. (Slack mobile is the reference; see `docs/mobile-ux.md`.)
- Paperclip button + drag-drop + paste for attachments.
- Mobile camera via `<input type="file" capture="environment">`. No PWA permissions dance.

## Pending message lifecycle

User messages render optimistically the moment Send fires. Each in-flight message carries a small status badge:

- `pending` — POSTed to `/api/chat/turn`, not yet acked.
- `failed` — POST failed; a retry affordance appears next to the bubble.
- `retrying` — user clicked retry; we resubmit and re-enter `pending`.
- (acknowledged) — daemon returned a `turn_id`; the optimistic bubble is replaced by the real `user`-kind block row when SSE delivers it.

Queued messages (received during a still-running turn) get synthesized bubbles on page load so a refresh doesn't lose them visually before the daemon drains the queue.

## Attachments

- Images (jpg/png/webp/heic), text files, PDFs as first-class. Anything else stored, path-passed to the agent.
- Content-addressed at `~/.friday/uploads/<sha-bucket>/<sha>.<ext>` (ADR-007).
- **Dedup is DB-driven**: hash incoming bytes → `SELECT * FROM attachments WHERE sha256 = ?`. If a row exists, reuse it (and verify the file is present on disk; re-write from incoming bytes if missing). If no row exists, write the file + insert the row. Path-existence alone is never authoritative.
- HEIC → PNG via sharp at upload. Conversion happens **before** the sha256 hash so dedup operates on the converted bytes.
- Oversized images downscaled to 2048×2048 (longest edge, no enlargement) in the same pass.
- Lazy-loaded in chat via `IntersectionObserver`.
- Preserve forever in v1; no GC.

## Markdown rendering

- `marked` parser + Svelte 5 wrapper component + DOMPurify sanitizer.
- Shiki for syntax highlighting (Catppuccin Latte / Mocha themes), grammars lazy-loaded per language.
- Streaming: re-parse at 5Hz debounce. Smooth, not thrashy.
- Code blocks: copy button, language label, **horizontal scroll on all viewports**. No wrap.
- Tool calls / tool results render as structured cards, not markdown.
- `<memory-context>`, `<skill-context>`, `<attachment>` blocks are stripped from rendered display.
- Plugin slots in `packages/shared/src/markdown/plugins.ts` for future KaTeX + Mermaid (see `docs/roadmap.md`).
- Server sends raw markdown text; client renders + sanitizes. One sanitization layer.

## Sub-agent reference rendering

When `agent_lifecycle event="spawn"` arrives during an in-flight orchestrator turn, the chat appends a markdown blockquote with the spawned agent's name + a clickable affordance. The Sidebar separately picks up the new agent via the registry; click-to-focus switches the chat pane.
