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

## Agent-type glyphs (sidebar)

The Sidebar renders each agent's type as a Lucide glyph, color-tinted
per type. The raw type string lives in the row tooltip for screen readers
and power users. Glyph map: orchestrator → `DraftingCompass`, helper →
`LifeBuoy`, builder → `Hammer`, scheduled → `CalendarClock`, bare →
`PawPrint`. Colors come from `--agent-<type>` CSS vars in `app.css` and
have both light and dark variants.
