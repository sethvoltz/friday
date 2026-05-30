# Chat UX

The dashboard's home `/` is a single persistent chat with Friday. This doc captures the UX shape: focus model, sidebar, slash commands, attachments, markdown rendering. Mobile-specific behaviors live in `docs/mobile-ux.md`.

## Single persistent chat

- Home `/` is _the_ chat with Friday. One persistent orchestrator named "Friday" (or whatever the user names it).
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

**Scroll-anchor preservation on prepend.** Naive `scrollTop = beforeTop + (newScrollHeight - oldScrollHeight)` arithmetic is sensitive to layout-flush timing and dies on subpixel rounding. Instead we capture the first rendered bubble's `data-msg-id` and its `getBoundingClientRect().top` _before_ triggering the load; after `await tick()` finds the same bubble in the new DOM, we shift `scrollTop` by the difference between its old and new offsets. Concrete elements, no scrollHeight math.

**WebKit / Safari / Orion paint-deferral.** Setting `scrollTop` while WebKit's scroll thread is still hot (fast-scroll just stopped, momentum still resolving) makes WebKit defer both the scroll-position commit and the paint of the newly-revealed region until the next user-originated scroll event. The DOM and layout are correct; the GPU paint is stale. Symptom: blank chat below a thin top band, fixed by any 1px scroll. We wrap the `scrollTop` write in a synchronous `overflow-y: hidden` → write → `setTimeout(0)` restore. Setting `overflow-y: hidden` detaches the element from the scroll thread, forcing WebKit to commit + paint synchronously; the async restore reattaches it once paint has happened. Synchronous restore reproduces the bug — the `setTimeout` tick is load-bearing. Pattern lifted from `inokawa/virtua` (PR #862, originally `prud/ios-overflow-scroll-to-top`). See ADR-019.

## Timestamps and grouping

Slack-canonical: relative wall-clock labels everywhere; same-author messages within 5 minutes collapse into a single group; only the first bubble of a group shows an inline timestamp.

- **Relative formatter** (`src/lib/util/time-format.ts`): same local day → `2:14 PM`; one day ago → `Yesterday at 2:14 PM`; within 6 days → `Tuesday at 2:14 PM`; older same year → `Mar 15`; older → `Mar 15, 2024`. All buckets are local-day deltas via `dayDelta()`, not "hours since" — so a message from 11:55 PM yesterday flips from "11:55 PM" to "Yesterday at 11:55 PM" at local midnight, not 24h after it was sent.
- **Day separator** on the local-day boundary: `Today` / `Yesterday` / `Saturday, May 17` / `Saturday, May 17, 2024` (year appended only when not the current local year).
- **Inactivity separator** (thin rule, no label) on any same-day gap >1h. Day wins over inactivity — both never render on the same boundary.
- **Grouping anchor** is the previous non-tool, non-thinking message. Streamed sub-blocks (`role === "tool"` / `"thinking"`) are continuations — they don't break grouping, don't emit separators, and don't carry their own inline timestamps. A tool block landing mid-gap doesn't suppress an inactivity separator on the next assistant bubble because the anchor's `ts` stayed at the previous text bubble.
- **Author identity** for grouping: `user` (chat), `mail:<fromAgent>` (mail-bridge user blocks group per sending agent), `agent:<name>` (assistant + no-response), `system:error` (error blocks). Different identities break the group even within 5 minutes.
- **Hover tooltip** (`title` attribute) carries the absolute datetime, `Sunday, May 17, 2026 at 2:14 PM`. Touch devices don't get hover affordances, which is the intended mobile behavior — no separate mobile path needed.
- **Per-minute tick.** `src/lib/stores/clock.svelte.ts` exposes a single shared `clock.now` `$state` updated once per local-minute boundary via `setTimeout` (aligned to `60_000 - (Date.now() % 60_000)`). Components read `clock.now` inside `$derived` / template expressions; one timer drives all relative-time updates across the whole dashboard. The grouping structure itself is a pure function of message `ts`/role/author and doesn't recompute on tick — only labels do.

## Slash commands and skills

Two flavors, one input:

### System commands

TypeScript-defined, deterministic, no LLM:

```
/archive <agent> /restart        /status         /inspect <agent>
/clear           /jump <date|term>    /scratch [name]
```

System commands return immediately. `/restart`, `/archive` and other destructive commands gate behind a confirmation modal. `/clear` is non-destructive — history is preserved as a past session — so it runs without a prompt.

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
agents: [orchestrator, helper] # restriction; omit for "all types"
allowed_tools: [tickets_search, mail_send] # optional subset restriction
auto_invoke: true # default true; built-ins set false
---
```

- **Built-in skills** live in `packages/shared/src/prompts/skills/*.md`. (Empty in v1; placeholder dir exists.)
- **User-additive skills** live in `~/.friday/skills/*.md`. Daemon watches both; collisions warn and the user file wins.
- Auto-invoke is essentially free via the Claude Agent SDK's skill dispatch.
- Manual invocation: typing `/<skill> args` at the start of a chat message injects the skill body as a `<skill-context>` block in the system prompt for that turn only. The remaining text becomes the user message.
- When a skill declares `allowed_tools`, the daemon assembles the SDK call with the **intersection** of the agent's normal tool set and the skill's declared tools. Per-turn, restriction-only — never expansion.

## Send + Stop buttons

- Send is **always visible**; it does not get replaced by Stop during in-flight turns. The daemon serializes prompts per agent (`nextPrompts` FIFO in `services/daemon/src/agent/lifecycle.ts`), so the user can type and queue a follow-up without waiting for the current turn to finish. Slash commands like `/restart` and `/scratch` ride a separate endpoint (`/api/commands`) and are never gated by an in-flight turn.
- Stop appears **alongside Send, to the right of it**, only while a turn is in flight. Sequence: paperclip · textarea · Send · Stop.
- `zeroSync.abortTurn(turnId)` → `abortTurn` Zero mutator + the localhost `/api/internal/abort-turn` fast-path → daemon's `AbortController.abort()`. The legacy `POST /api/chat/turn/<id>/abort` REST route retired in FRI-123 (ADR-024 retirement set).
- Aborts at next SDK iteration. Tool calls already in flight finish; no next step. Honest UI copy: _Stop prevents future steps. It can't undo a step already started._
- Stop only cancels the running turn — anything sitting in `nextPrompts` after it stays queued and dispatches on the next idle window.

### Stop confirmation (FRI-95)

The Stop affordance is rendered on the **user block** for the turn (id `user_<turn_id>`) — it's the always-present surface, independent of whether an assistant bubble has streamed yet. The assistant bubble keeps its own existing footer for the streaming case; the user-block footer is the load-bearing one for early-stop / queued / pre-token aborts.

Three outcomes, each with deterministic chat-visible copy:

| Outcome                                                         | When                                                                                                                                                                    | User-block footer                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Optimistic (`status="stopping"`)                                | Client-side, the instant Stop is clicked. Flipped by `chat.requestStop(turnId)`.                                                                                        | `Stopping…`                               |
| Clean abort (`status="aborted"`, `abortReason="cooperative"`)   | Daemon `turn_done` with `abort_reason="cooperative"` — worker honored the abort cleanly.                                                                                | `Stopped`                                 |
| Force-killed abort (`status="aborted"`, `abortReason="forced"`) | Daemon `turn_done` with `abort_reason="forced"` — the 500ms deadline elapsed, worker SIGTERMed. The `stopped_forced` error block lands as a sibling chat message.       | `Stopped — worker had to be force-killed` |
| Already-finished race (`status="already_finished"`)             | Stop fired but the daemon's `turn_done` arrived with `status="complete"` — model's last token raced ahead of the abort. Brief 1s transient, settles back to `complete`. | `Already finished`                        |

Re-pressing Stop while already in the `stopping` state is a no-op (the in-flight POST is fire-and-forget; the UI is already in the right place).

## Chat input

- Plain text → orchestrator turn.
- `/` opens autocomplete — system commands first (badged "system"), skills second.
- **Slack-style keyboard nav** (FIX*FORWARD 6.2). With the menu open: first ArrowDown / ArrowUp transfers focus \_into* the menu (the input caret stops blinking, the menu item highlights). Subsequent arrows navigate items. **Tab** or **Enter** applies the selection and returns focus to the input with the cursor at end. **Esc** closes the menu and keeps focus in the input. Enter with the menu closed submits the turn as usual.
- On mobile: tap-to-insert preserves keyboard focus. `pointerdown` + `preventDefault` on the autocomplete entry so the input never blurs. (Slack mobile is the reference; see `docs/mobile-ux.md`.)
- Paperclip button + drag-drop + paste for attachments.
- Mobile camera via `<input type="file" capture="environment">`. No PWA permissions dance.

## Pending message lifecycle

User messages render optimistically the moment Send fires. There are two distinct queueing concerns here — the **client send-queue** (network resilience, persisted in localStorage) and the **daemon nextPrompts FIFO** (server-side serialization behind an in-flight turn). Both surface in the same bubble; the status pill tells them apart.

States:

- `pending` — `sendUserMessage` mutator dispatched; the daemon's `dispatch-listener` hasn't run yet (sub-second window). The block is at `status='pending'` in Postgres; Zero replicates it locally and the bubble renders optimistically. Pinned to the bottom regardless of natural ts sort.
- `failed` — mutator returned an error; a retry / discard affordance appears next to the bubble (per-bubble retry, "discard one", "discard all").
- `retrying` — mutator dispatch network failure; the Zero outbox is scheduling a backoff retry.
- `queued` — `dispatch-listener` picked the row up but the worker was mid-turn, so the daemon UPDATEd the block to `status='queued'`. The bubble stays pinned to the bottom and shows an **X cancel affordance**: clicking X dispatches the `cancelQueued` Zero mutator (plus the localhost `/api/internal/cancel-queued` fast-path that splices `nextPrompts` synchronously), the cancel-listener deletes the row, and the recovered text is prepended into the input bar with the caret parked at the end of the recovered text (separated from any in-progress draft by `\n\n`). The legacy `DELETE /api/chat/turn/<id>/queued` REST route retired in FRI-123.
- (dispatched) — the worker finally drains this prompt from `nextPrompts`. The daemon `UPDATE`s the block to `status='complete'` with a fresh `ts` (dispatch time) and emits a `block_meta_update` SSE event. The dashboard unpins the bubble and re-sorts it inline.

The re-stamp is what makes the "natural timestamp" sort work: the POST-time `ts` would otherwise place the queued bubble above the still-streaming assistant blocks of the in-flight turn, which looks wrong.

**Durability across daemon restart.** On boot, the daemon scans `blocks WHERE status='queued' ORDER BY ts` and dispatches each row via the normal `dispatchTurn` path (oldest first — the first one spawns the worker, the rest queue behind it). Archived agents are skipped and their queued rows deleted. See `recoverQueuedTurns` in `services/daemon/src/index.ts`.

**Send-queue synthesized bubbles** still render on page load for entries that haven't even reached the daemon yet (offline / 5xx in flight before a successful POST). These carry a `queueId` rather than a daemon-issued `turnId`.

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
- Links: a post-render pass (`processLinks` in `Markdown.svelte`) opens **absolute** hrefs (`scheme:` or protocol-relative `//`) in a new tab with `target="_blank" rel="noopener noreferrer"`; relative/internal paths (`/foo`, `#hash`) stay in the same tab so SvelteKit navigation keeps working. The absolute-vs-relative decision is the pure `linkTargetAttrs` helper (`link-target.ts`), unit-tested without a DOM. Agents emit GitHub PR/issue references as full markdown links (`[#123](https://github.com/owner/repo/pull/123)`) via the `pr-links` protocol (FRI-131), so a `#123` mention renders clickable; bare `#123` is **not** auto-linked.

## Tool-block rendering dispatch

`ChatMessages.svelte` routes every `role === "tool"` block through a per-tool renderer registry (`$lib/components/Chat/tool-renderers.ts`) instead of a growing inline `toolName === …` chain.

- `resolveToolRenderer(toolName)` looks up a purpose-built renderer: first by the raw `toolName` (built-in literal, e.g. `TodoWrite` / `Write` / `Edit`), then by the MCP **short segment** captured from `/^mcp__[^_]+__(.+)$/` (e.g. `mail_send` for `mcp__friday-<server>__mail_send`, for any `<server>`). It returns `undefined` when nothing is registered, and the dispatch site falls back to the generic `ToolBlock` — so unregistered tools render exactly as before.
- The registry (`TOOL_RENDERERS`) is populated one line per renderer. Registered renderers are mounted via the Svelte 5 runes-mode dynamic form (`{@const R = r.component}<R … />`), never the deprecated `<svelte:component>`. Currently registered:
  - `TodoWrite` → `TodoList.svelte` (FRI-133): renders the agent's task list directly — one row per todo in input order, with a per-status state indicator (completed = checked + `line-through`, in_progress = active marker, pending = empty) — wrapped in `CollapsibleSection` (`startOpen`, height-capped) so a long list is visible at a glance but clamped. The row label is the present-continuous `activeForm` for `in_progress` rows and the imperative `content` for `pending`/`completed`, each falling back to the other field when empty so a row never renders blank. Parsing + label/marker selection live in the pure sibling module `todo-render.ts` (unit-tested in the node pool; the rendered DOM is pinned by `e2e/todo-renderer.spec.ts`). The tool_result confirmation string is ignored — `input.todos` is the canonical state.
  - `Write` / `Edit` / `MultiEdit` / `NotebookEdit` → `FileEditRenderer.svelte` (FRI-134): the file-edit family, promoted so the diff renders directly under the tool row (see [File-edit diff renderer](#file-edit-diff-renderer-fileeditrenderer--filediff) below).
  - `mail_send` / `mail_inbox` / `mail_read` / `mail_close` → `MailToolBlock.svelte` (FRI-135): the four friday-mail tool calls, rendered as message previews / summaries instead of the raw-JSON card (see [friday-mail renderer](#friday-mail-renderer-mailtoolblocksvelte) below).
- Every renderer accepts the same six-prop contract (`ToolRendererProps`: `toolName`, `friendlyName?`, `status`, `input?`, `inputPartialJson?`, `output?`), spread identically into either the renderer or `ToolBlock`.
- Do **not** key the registry on `friendlyToolName` output: it returns human labels (e.g. `"Create agent"`) for mapped friday tools, which are useless registry keys. Key on the literal name or the MCP short segment.

### File-edit diff renderer (`FileEditRenderer` → `FileDiff`)

`Write` / `Edit` / `MultiEdit` / `NotebookEdit` are **promoted**: their diff renders directly under the tool row, not two clicks deep behind a collapsed `ToolBlock` card. `FileEditRenderer.svelte` is a thin adapter that maps the raw SDK input (snake_case) to `FileDiff`'s camelCase props via the pure, DOM-free `file-edit-input.ts:mapFileEditInput` and mounts `FileDiff` directly — it adds **no** `CollapsibleSection` of its own, so the single height cap + `+`/`−` control is the one `FileDiff` already wraps (`collapsedMaxHeight={400}`). Exactly one cap, one scroll container.

- **`Write`** (`file_path`, `content`) and **`NotebookEdit`** replace/insert (`notebook_path`, `new_source`, `cell_type`) render as a Shiki-highlighted **content view** (no old-source → not a two-sided diff). `NotebookEdit` `edit_mode: "delete"` renders a "Cell deleted" notice.
- **`Edit`** (`old_string`, `new_string`) renders a single two-sided hunk (`diffLines`); side-by-side ≥768px, unified below.
- **`MultiEdit`** (`edits: [{ old_string, new_string }]`) renders **K stacked hunks** — one diff group per edit, separated by a thin rule, all sharing the one cap.
- The adapter tolerates the daemon's `{ _raw: <partialJson> }` streaming-fallback input (no `file_path`/`old_string`): the mapping yields empty props and `FileDiff` shows a placeholder rather than crashing.
- `Read` is **not** promoted (no diff to show) — it stays on the generic `ToolBlock`. `ToolBlock` no longer mounts `FileDiff`; its old `showFileDiff` branch is removed.

### friday-mail renderer (`MailToolBlock.svelte`)

The four friday-mail tool **calls** — `mail_send`, `mail_inbox`, `mail_read`, `mail_close` — render through one `MailToolBlock` component (four `TOOL_RENDERERS` entries under the bare short names, branching internally on the short segment) instead of the generic raw-JSON card. It works entirely from the block data the dashboard already holds — `input` (the parsed tool-use object) and `output` (the tool-result string) — and never fetches the `mail` table.

- `mail_send` → a message preview (`<dl>` of to / subject / type / priority + the body in a `CollapsibleSection`); the priority is tinted `--status-error` when `critical`, mirroring `MailBlock`. Never dumps the raw send input as JSON.
- `mail_read` / `mail_inbox` → `JSON.parse(output)` to a `MailRow` / `MailRow[]` for a compact summary (from / subject / body, or a per-row inbox list; an empty inbox reads "Inbox empty"). Tolerates `subject === null` (renders nothing, never the literal `"null"`). On parse failure, falls back to the raw `output` text inside a `CollapsibleSection`.
- `mail_close` → a one-line "mail #id closed" confirmation.
- Header headline reuses `synthesizeHeadline(toolName, input)`; mid-stream (status `running`, `input` not yet populated) it falls back to a per-tool default ("Sending mail", "Checking mail inbox", …) plus the status badge, and never throws on `undefined` input/output.
- **Out of scope:** incoming mail (`role==="user"`, `source==="mail"`) still renders via `MailBlock.svelte` — that is the agent's inbox, not its outgoing tool calls.

## Height-capped collapsible primitive

`CollapsibleSection.svelte` is the shared "shown-directly, height-capped, expand-for-more" primitive. Content renders directly (not buried behind a separate disclosure click); when collapsed it is clamped to `collapsedMaxHeight` px (default 320) with `overflow-y: auto`, and a `+` / `−` control toggles to full height. It encodes the [disclosure-glyph convention](ui-conventions.md) (`aria-hidden` glyph, `aria-expanded` button, no chevrons) and exposes `open` as `$bindable` so a renderer can read/drive expansion. `FileDiff` (400px) and `ToolBlock` input/output bodies (300px) are refactored onto it; `ThinkingBlock` and `MailBlock` still hand-roll their own toggles until a renderer needs them.

## Sub-agent reference rendering

When `agent_lifecycle event="spawn"` arrives during an in-flight orchestrator turn, the chat appends a markdown blockquote with the spawned agent's name + a clickable affordance. The Sidebar separately picks up the new agent via the registry; click-to-focus switches the chat pane.
