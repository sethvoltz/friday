# Friday

Domain language for the Friday agent platform — the headless daemon, the
SvelteKit dashboard, and the shared packages that bind them.

## Language

### Theming

**Mode**:
The light/dark policy. One of `light | dark | system`. Resolved at runtime
via `prefers-color-scheme`; decides which slot of the active **Theme** is
in effect when the user is on **Sync**. Internal-only — there is no
user-facing **Mode** picker.
_Avoid_: theme (as a synonym for mode), color-scheme (when discussing the user's setting).

**Palette**:
A named, complete set of color tokens (e.g. **Dawn**, **Dusk**).
Palettes are not bimodal — each palette renders exactly as defined, in
whichever slot it sits. Every palette is selectable in any slot.
_Avoid_: theme (when referring to one named color set), skin, scheme.

**Palette kind**:
An intrinsic flag on each **Palette** — `light` or `dark` — describing the
visual style of its tokens. **Dawn** is `light`-kind; **Dusk** is
`dark`-kind. Kind is metadata, not a constraint on which slot a **Palette**
can occupy. It drives sub-themed renderers (Mermaid, Shiki) and the
browser-integration signals (`color-scheme`, `theme-color`) so they follow
the active **Palette**, not the user's **Mode**.

**Theme**:
The user's full theming selection. Has two configurations:

- **Single**: one **Palette** wins, regardless of **Mode**.
- **Sync**: one **Palette** per slot (light, dark); the active one follows
  the resolved **Mode**.

The user's three **Palette** picks (single, light, dark) are stored
independently and may each be unset. Until the user explicitly picks for a
slot, the resolver falls back to a built-in default — so toggling between
**Single** and **Sync** before any pick is a no-op visually.
_Avoid_: palette (when referring to the user's whole selection), preferences.

### Known palettes

**Dawn**: The warm, airy palette that currently sits in `:root` in
`app.css`. The Friday default for the light slot.

**Dusk**: The cool, technical blue palette that currently sits in `.dark`
in `app.css`. The Friday default for the dark slot.

### Surface tokens

**Chat aurora**: The three signature hues that drive the conic-gradient
animation around the chat input. Defined per-palette as
`--chat-aurora-1|2|3`. Each **Palette** picks its own three hues — these
aren't fixed brand colors; they're a per-palette aesthetic choice.

## Relationships

- A **Theme** is either **Single** (one **Palette**) or **Sync** (a pair
  of **Palettes**, one per slot).
- The active **Palette** is determined by **Theme** + **Mode**:
  - **Single** → the chosen **Palette**, **Mode** ignored.
  - **Sync** → the **Palette** assigned to the slot matching the resolved
    **Mode**.
- Every **Palette** is available for every slot — there is no "light-only"
  or "dark-only" **Palette**.
- The active **Palette** stamps two classes on `<html>`:
  `.palette-<name>` (exactly one at a time) and `.dark` (iff the active
  **Palette**'s kind is dark). CSS token blocks key off `.palette-<name>`;
  kind-dependent rules (Shiki, Mermaid) key off `.dark`. The `.dark` class
  is repurposed: under the previous design it tracked the user's **Mode**;
  it now tracks the active **Palette**'s kind.
- **Theme** state is canonically stored in Postgres (`settings` table,
  flat columns); the dashboard mirrors it to localStorage on every change
  so the pre-paint FOUC script can resolve the active **Palette**
  synchronously on the next page load.

## Example dialogue

> **Dev:** "If the user picks **Dawn** as their dark-slot default, what happens at night?"
> **Domain expert:** "**Dawn** renders as **Dawn**. The active **Palette** is **Dawn**, the **Mode** is `dark`, but the page looks warm and light — the **Palette** owns the colors, not the **Mode**."

## UI surface names

**Appearance**: The Settings card that exposes the **Theme** controls
(Single/Sync toggle, **Palette** pickers). User-facing label only — not a
domain concept. Matches the convention macOS and GitHub use; keeps the
domain vocabulary (Mode/Palette/Theme/Kind) out of the user-facing UI.

## Flagged ambiguities

- "Theme" historically meant "the Friday light/dark pair." It now means
  the user's whole theming selection. Old uses in commits / docs that
  refer to "the dark theme" usually mean the **Dusk Palette**.
- The Settings card titled "Theme" today is really a **Mode** picker; it
  is being renamed to **Appearance** and grown to expose the full **Theme**
  (Single/Sync + **Palette** picks).
