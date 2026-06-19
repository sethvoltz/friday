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

### Agent turn lifecycle

**Turn state**:
The authoritative in-daemon record of where an agent's worker sits in its
turn — `idle | working | aborting | force-killed` — together with its
current **Generation**. Lives in daemon memory; it is the source of truth.
_Avoid_: status (reserve that for the projection), worker state.

**Turn-state machine**:
The single module that owns an agent's **Turn state** and is the only
writer of it. Applies **Transition**s and emits intents
(`send-next`, `force-kill`, `recover`).
_Avoid_: lifecycle handler, worker manager, dispatcher.

**Transition**:
One state-affecting input applied to the **Turn-state machine** — a worker
IPC event, an abort, a force-kill, a refork, a spawn, or a worker exit.
_Avoid_: event (too broad), message.

**Transition queue**:
The per-agent-name serialized queue every **Transition** funnels through,
so transitions for one agent apply in strict arrival order with no
interleaving. The agent-keyed successor to the per-worker `ipcChain`.
_Avoid_: ipcChain (its narrower predecessor), mailbox.

**Generation**:
A worker instance's standing as the current owner of its agent name
(`live.get(name) === w`). A **Transition** arriving from a superseded
**Generation** is a structural no-op. Identity-as-epoch — promoted to a
monotonic counter only if cross-gap ordering is ever needed.
_Avoid_: epoch (unless promoted), version.

**Status projection**:
A read-optimized mirror of **Turn state**, written only inside a
**Transition** and never mutated independently — `w.status` (in-memory,
`idle | working`) and `agents.status` (durable, written through the
ADR-031 `registry.setStatus` gate, replicated to clients by Zero).
_Avoid_: status (when you mean the authoritative **Turn state**).

### Habits

**Habit**:
A named thing the user intends to do on a repeating cadence and checks off
(e.g. "brush teeth", "run a 5K"). The tracked definition — not any single
occurrence and not its streak. Has one of two **Habit mode**s.
_Avoid_: routine (kitchen owns that for recurring cooking patterns —
`kitchen_routine_add`; reusing it makes the glossary unable to
disambiguate), task, reminder (a reminder is a nudge; a Habit is a tracked
commitment).

**Check-in**:
A single logged completion of a **Habit** — one event, timestamped. A
**Period** may hold _many_ Check-ins (write 5 blog posts → 5 Check-ins) and
all of them are recorded as **volume**; only the first **Target**-many count
toward the **Streak**. The append-only atoms everything else is derived from.
_Avoid_: completion (acceptable synonym but prefer Check-in), tick, done.

**Period**:
The recurrence window a **Habit**'s **Target** is measured over — one of
`day | week | month | year`, optionally constrained to specific weekdays
(e.g. Mon/Wed/Fri ⇒ each of those days is its own day-Period). The unit the
**Streak** is counted in. Cron's vocabulary suggests _which_ Periods exist
but is not used to tally Check-ins into them.
_Avoid_: interval, cadence (use cadence informally for the whole
Target+Period shape, not for the window alone), bucket (that's
**Time-of-day bucket**, a display attribute — distinct).

**Target**:
The number of **Check-in**s required within one **Period** to _satisfy_ it
(default 1). "20 workouts/month" ⇒ Target 20, Period month. Check-ins beyond
the Target in a Period are still logged as volume but do not further advance
the **Streak**.
_Avoid_: goal (overloaded), quota (acceptable synonym).

**Satisfied period**:
A **Period** whose **Check-in** count reached its **Target**.

**Streak**:
The run of consecutive **Satisfied period**s for a **Habit**, counted in its
**Period** unit (days-in-a-row, months-in-a-row, …). A _derived, time-
dependent_ projection of the **Check-in** log against the **Target**/
**Period** and the current clock — never stored as truth, never created
directly by the user. Three states:

- **Dormant**: no run is active — either none has ever started, or the last
  one just broke. The next **Satisfied period** (re)starts it.
- **Active, current period pending**: N consecutive prior **Satisfied
  period**s; the current (open) Period is below **Target**. Shows **N** and
  holds — neither advanced nor broken.
- **Active, current period satisfied**: the open Period reached **Target** →
  shows **N+1**.

A Streak breaks on a _clock boundary_, not a Check-in: it drops to **Dormant**
the instant an unsatisfied **Period** _closes_ (e.g. midnight at month-end).
Because the value depends on `now()`, it is computed on read, not stored.
_Avoid_: count (too generic), habit (the Streak is not the Habit).

**Time-of-day bucket**:
An optional display/scheduling attribute on a **Habit** —
`morning | afternoon | evening | anytime`. Groups "today's habits" in the UI
and times an optional reminder. **Not** part of Check-in identity and **not**
a **Streak** determinant (v1).
_Avoid_: period (that's the **Streak** window), slot.

**Slot**:
One unit toward a **Period**'s **Target**; renders as one square in the UI. A
Period with Target N has N Slots, filled in order by **Check-in**s.
Two families by how a Slot resolves:

- **Per-day Slot** (Habits whose Target is per-day — daily, every-day, MWF):
  each Slot is bound to a specific day and **fills or slashes at that day's
  end**.
- **Floating Slot** (Habits whose Target is per multi-day Period — N/week,
  N/month, N/year): Slots are unbound, fill in order, stay **empty** while the
  Period is open, and the unfilled remainder **slashes only at Period close**.

Square states: empty (outline, not yet missed) · slashed (light diagonal,
expected-but-window-closed = a miss) · filled (the **Habit color**). Check-ins
past Target render as **overflow** (`+k`), counted as volume, not toward the
**Streak**.
_Avoid_: cell, box.

**Habit color**:
A per-**Habit** color stored as an **index** (1–7), never a hex. Each
**Palette** supplies the actual 7 colors via a habit ramp it must define —
the index map leans ROYGBIV but a Palette may reinterpret it within its own
language (e.g. **Phosphor** renders all seven as shades of green). Same
contract as the rest of the **Theme** system: the Habit picks a slot in the
ramp, the active **Palette** owns the value, so Habit colors re-theme
automatically.
_Avoid_: hue, swatch (UI affordance, not the stored value).

**Habit mode**:
The lifecycle shape of a **Habit**. One of:

- **Ongoing**: open-ended; the **Streak** grows indefinitely and the Habit
  never archives on its own.
- **Bounded**: has a defined window (start + end / start + length); the
  **Streak** runs against that window. When the window closes the Habit
  archives as _completed_ (window finished, Streak intact) or _expired_
  (window finished, Streak broken).

Motivation-neutral — **Bounded** covers a fitness challenge, a medication
course, and a free-trial cadence equally.
_Avoid_: challenge (too narrow — implies aspiration/fitness), fixed-duration
(clunky), goal/sprint/season (carry foreign domain baggage).

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
- "status" was used for both the authoritative in-daemon state and the
  `agents.status` DB column — resolved: the authoritative concept is
  **Turn state**; `agents.status` and `w.status` are **Status projection**s
  of it. The pre-refactor `suppressIdleReset` / `forceKilled` flags were
  hand-rolled guards against a superseded **Generation** writing a
  projection; the **Generation** no-op rule replaces both.
