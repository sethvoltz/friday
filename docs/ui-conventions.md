# UI Conventions

Cross-cutting visual / interaction patterns that the dashboard applies
consistently so the user doesn't have to learn a new gesture per surface.

## Expand / collapse disclosure

Any control that toggles a section between collapsed and expanded uses
**`+` (collapsed)** and **`−` (expanded)** as its disclosure glyph.
Apply the convention everywhere a header reveals supplementary content:
chat tool blocks, thinking blocks, mail blocks, error details, sidebar
history submenus, the mobile sidebar trigger, evolve proposal rows.

- Do **not** mix in chevrons (`▸ ▾`), triangles (`▴ ▾`), carets, or bullets
  for the same purpose. The literal plus/minus glyphs read as "click to
  show / hide" without any iconography vocabulary to learn.
- The glyph is the affordance, not decoration — render it inside the
  clickable element and mark it `aria-hidden="true"`. The button itself
  carries `aria-expanded={open}` so screen readers announce state.
- Chevrons remain fine for **direction-of-travel** indicators (next page,
  breadcrumb separators) — those aren't disclosure.

The chat surface bakes this convention into a reusable primitive,
`CollapsibleSection.svelte` (see `docs/chat-ux.md`): it renders the `+` / `−`
glyph with `aria-hidden="true"`, carries `aria-expanded` on the button, and
caps collapsed content to a `collapsedMaxHeight` prop. New chat renderers
should wrap their directly-shown body in it rather than re-deriving the toggle
plus a magic max-height.

- **No toggle when it fits.** The disclosure control (and the height clamp)
  appear **only when the content actually exceeds `collapsedMaxHeight`** —
  measured from the body's `scrollHeight`. A section whose content already
  fits shows in full with no `+` / `−` affordance and no clamp (a one-line
  file edit or a three-row todo list never gets a toggle that toggles
  nothing). A renderer can still supply its own clickable header as the
  disclosure control via the `header` snippet (it receives
  `{ open, toggle, showToggle }`); `showToggle === false` means the header
  must render non-interactively, no glyph, no `aria-expanded`. The pure
  derivation lives in `collapsible-toggle.ts:shouldShowToggle`.

## Floating overlay pills

Transient, position-relative chat affordances render as **floating pills**
(`.floating-pill` in `ChatShell.svelte`): a small blurred-background rounded
control that floats over the message list rather than occupying layout. The
same class backs the jump-to-bottom pill, the loading-older indicator, and the
"Viewing pre-compaction history" pill (FRI-156). A new "scroll back to X" or
"you are at position Y" affordance should reuse `.floating-pill` and sit in the
same overlay band — don't invent a bespoke floating chrome per surface. The
pill's visibility is derived from a scroll/`IntersectionObserver` signal, never
from a manual toggle.

## Agent-type glyphs (sidebar)

The Sidebar renders each agent's type as a Lucide glyph, color-tinted
per type. The raw type string lives in the row tooltip for screen readers
and power users. Glyph map: orchestrator → `DraftingCompass`, helper →
`LifeBuoy`, builder → `Hammer`, scheduled → `CalendarClock`, bare →
`PawPrint`. Colors come from `--agent-<type>` CSS vars in `app.css` and
have both light and dark variants.

## Status dots (sidebar + command palette)

A small colored dot left of each agent name encodes runtime state. The dot
**color** comes from `agentStatusDot(status, { compacting })`
(`$lib/util/agent-status-dot.ts`) — the single source of truth for the color,
used by both the Sidebar and the Command Palette. The **pulse** animation is a
per-component CSS concern (each surface defines its own keyframes), but the
color and the set of states are shared:

- **working** → `--status-ok` (green), with a soft pulsing ring.
- **stalled** → `--status-warn` (amber).
- **idle / archived / unknown** → `--text-tertiary` (muted); archived rows draw
  a hollow ring instead of a filled dot.
- **compacting** → `--status-compacting` (cyan), with a **slower** pulse so a
  compacting agent is distinguishable from a normally-working one at a glance,
  _even when it isn't the focused agent_. This state is **orthogonal** to status
  (compaction runs while the agent stays `working`), so callers pass it as
  `agentStatusDot(status, { compacting })` where `compacting =
chat.isAgentCompacting(name)` — the union of the transient `compacting` SSE
  signal and the durable `agents.compacting_since` column, so it survives
  reload/reconnect. The markup binds `pulse` and `compacting` as mutually
  exclusive classes. See `docs/chat-ux.md` → _Compaction divider_. All pulses
  respect `prefers-reduced-motion`.
