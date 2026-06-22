<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * RailShell — generic, content-agnostic responsive layout scaffold
   * (FRI-172, AC1–4b). Mirrors Chat's floating contained-panel shell while
   * staying an IN-FLOW page (it is NOT Chat's fixed-viewport model).
   *
   * Two layouts driven by a single `matchMedia` breakpoint:
   *
   *   Desktop (> breakpoint): a CSS grid with a fixed-width left rail column
   *   and a flexible main column. The rail is a FLOATING CONTAINED PANEL —
   *   `--bg-card` surface, 1px `--border-subtle`, `--radius-lg`, `--shadow-lg`
   *   — identical chrome to ChatShell's `.chat-sidebar-floating`, but rendered
   *   in flow with `position: sticky; top: var(--header-clearance)` instead of
   *   `position: fixed`. The header clearance is already supplied by
   *   `.app-main`'s `padding-top` (see §3 of the visual contract / app.css);
   *   RailShell adds NO second offset — the sticky `top` only re-clears the
   *   header during scroll. The rail owns its OWN `overflow:auto` so a long
   *   facet/filter list scrolls independently of the main pane (AC20).
   *
   *   Mobile (≤ breakpoint): the rail collapses behind a `Filters (n)` trigger
   *   row styled like Sidebar's `.trigger` (it also hosts the optional
   *   `topbar` snippet — search + active-filter chips). Tapping the trigger
   *   expands a Sidebar-style anchored rounded `.dropdown` sheet (NOT a
   *   full-height drawer) that renders the same `rail` snippet.
   *
   * This component is DELIBERATELY ignorant of its contents (AC1): it imports
   * nothing from `$lib/stores/zero`, no chat store, nothing from the Memory
   * components, and references no Memory/facet symbol. Everything is slotted via
   * the `rail` / `main` / `topbar` snippets. The ONLY state it owns is the
   * breakpoint (`isMobile`) and the sheet's open/closed flag (`sheetOpen`, two-
   * way bound) — `openId`, facet state, etc. live in the parent (AC1c).
   *
   * a11y (NET-NEW vs Sidebar, which has none on its mobile popover): the mobile
   * sheet is a `role="dialog" aria-modal="true"` surface; Escape closes it;
   * focus moves to the first focusable element on open and is Tab-trapped
   * (wrap last→first, Shift+Tab first→last); on close, focus RESTORES to the
   * `Filters` trigger. The trigger carries `aria-expanded` + `aria-controls`.
   */
  interface Props {
    /** Desktop left-rail / mobile sheet body. */
    rail: Snippet;
    /** Main pane. */
    main: Snippet;
    /** OPTIONAL mobile-only top bar (search + active-filter chips). */
    topbar?: Snippet;
    /** px max-width treated as "mobile". Matches Sidebar's 768. */
    breakpoint?: number;
    /** Accessible label for the sheet + base text of the mobile button. */
    railLabel?: string;
    /** Optional count rendered in the mobile `Filters (n)` button. */
    railCount?: number;
    /** Two-way: lets the parent close the sheet after a filter pick. */
    sheetOpen?: boolean;
  }
  let {
    rail,
    main,
    topbar,
    breakpoint = 768,
    railLabel = "Filters",
    railCount,
    sheetOpen = $bindable(false),
  }: Props = $props();

  // Breakpoint state lives HERE only (AC1c). Mirrors the Sidebar.svelte
  // matchMedia idiom: SSR-guarded early return, apply-on-mount + on-change,
  // force the sheet closed when we leave mobile, and clean up the listener.
  let isMobile = $state(false);

  $effect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const apply = () => {
      isMobile = mq.matches;
      // Leaving mobile must dismiss the sheet — the desktop layout renders
      // the rail inline, so a lingering `sheetOpen` would be invisible state.
      if (!isMobile) sheetOpen = false;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  });

  // The Filters trigger — focus restores here when the sheet closes.
  let triggerEl = $state<HTMLButtonElement | undefined>();
  // The sheet dialog element — focus-trap + first-focusable scope.
  let sheetEl = $state<HTMLDivElement | undefined>();
  // The anchor wrapping BOTH the trigger and the dropdown — the outside-close
  // boundary (mirrors Sidebar's `rootEl`, which likewise spans trigger+popover).
  let anchorEl = $state<HTMLDivElement | undefined>();
  // Stable id wiring the trigger's `aria-controls` to the dialog.
  const sheetId = "railshell-sheet";

  // Outside-pointerdown closes the sheet (Sidebar :432–440 idiom). Only armed
  // while open; the listener is torn down on close. The boundary is the ANCHOR
  // (trigger + dropdown), NOT just the sheet — exactly like Sidebar checks its
  // `rootEl`. If we checked `sheetEl` alone, a pointerdown on the trigger (which
  // sits OUTSIDE the sheet) would close the sheet on this handler and the
  // trigger's own click would immediately re-open it — a double-toggle that
  // makes the trigger unable to dismiss the sheet.
  $effect(() => {
    if (!sheetOpen) return;
    const onDown = (e: PointerEvent) => {
      const boundary = anchorEl ?? sheetEl;
      if (!boundary) return;
      if (!boundary.contains(e.target as Node)) sheetOpen = false;
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  });

  function focusableWithin(root: HTMLElement): HTMLElement[] {
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
  }

  // On open: move focus into the sheet (first focusable, else the sheet
  // itself). On close: restore focus to the trigger that opened it. Guarded
  // for SSR. The `sheetOpen` read makes this re-run on every transition.
  $effect(() => {
    if (typeof window === "undefined") return;
    if (sheetOpen && sheetEl) {
      const focusables = focusableWithin(sheetEl);
      const first = focusables[0] ?? sheetEl;
      // Defer to after the dialog has painted so offsetParent is non-null.
      queueMicrotask(() => first.focus());
    } else if (!sheetOpen && triggerEl) {
      // Only steal focus back if it's currently somewhere inside (or nowhere
      // meaningful) — don't yank focus away if the user already tabbed out.
      const active = document.activeElement;
      if (!active || active === document.body) triggerEl.focus();
    }
  });

  // Keydown handler on the dialog: Escape closes; Tab is trapped to the sheet's
  // focusable ring (wrap last→first forward, first→last with Shift).
  function onSheetKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      sheetOpen = false;
      // Restore focus immediately (the close `$effect` also covers this, but
      // doing it here keeps Escape feeling synchronous).
      triggerEl?.focus();
      return;
    }
    if (e.key !== "Tab" || !sheetEl) return;
    const focusables = focusableWithin(sheetEl);
    if (focusables.length === 0) {
      // Nothing focusable inside — keep focus pinned to the dialog.
      e.preventDefault();
      sheetEl.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !sheetEl.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !sheetEl.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // The mobile button label: `Filters` when no count, `Filters (n)` otherwise.
  const triggerLabel = $derived(railCount == null ? railLabel : `${railLabel} (${railCount})`);
</script>

<div class="railshell" class:is-mobile={isMobile}>
  {#if isMobile}
    <!-- The trigger row is its OWN positioning context so the dropdown sheet
         anchors directly under the button (Sidebar idiom), not under the
         search/chips that may also live in the topbar. -->
    <div class="topbar">
      {@render topbar?.()}
      <div class="trigger-anchor" bind:this={anchorEl}>
        <button
          type="button"
          class="filters-trigger"
          bind:this={triggerEl}
          aria-expanded={sheetOpen}
          aria-controls={sheetId}
          aria-haspopup="dialog"
          onclick={(e) => {
            e.stopPropagation();
            sheetOpen = !sheetOpen;
          }}>
          <span class="filters-label">{triggerLabel}</span>
          <span class="filters-glyph" aria-hidden="true">{sheetOpen ? "−" : "+"}</span>
        </button>

        {#if sheetOpen}
          <!-- A Sidebar-style anchored rounded dropdown (NOT a full-height
               drawer). It still carries dialog semantics (role=dialog /
               aria-modal) + Escape + focus-trap + outside-pointerdown — the
               net-new a11y RailShell intentionally keeps over Sidebar. -->
          <div
            id={sheetId}
            class="sheet"
            bind:this={sheetEl}
            role="dialog"
            aria-modal="true"
            aria-label={railLabel}
            tabindex="-1"
            onkeydown={onSheetKeydown}>
            <div class="sheet-rail">
              {@render rail()}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <aside class="rail">
      {@render rail()}
    </aside>
  {/if}

  <!-- The main pane is rendered ONCE, OUTSIDE the breakpoint branch, so flipping
       `isMobile` (a window resize / device rotation) only swaps the rail
       placement — it never tears down + remounts the main pane. An in-progress
       inline edit in the slotted content therefore survives the layout switch.
       (Bug fix: previously `main` lived in both branches, so a resize mid-edit
       remounted the editor and discarded the user's changes.) -->
  <section class="main">
    {@render main()}
  </section>
</div>

<style>
  /* ---- Desktop: a FLOATING CONTAINED rail panel + flexible main, mirroring
     ChatShell's `.chat-sidebar-floating` + main, but IN FLOW (no
     position:fixed). The two columns are normal grid children of `.app-main`,
     which already reserves the header band via `padding-top: 5.5rem`
     (= --header-clearance) — so neither column sits under the floating header.
     `align-items: start` keeps each column at its own height (the sticky rail
     must not be stretched to match a tall main column). */
  .railshell {
    box-sizing: border-box;
  }
  /* Desktop: a CSS grid — fixed-width rail column + flexible main column. The
     `main` section is always the 2nd child; only the 1st child swaps between
     `aside.rail` (desktop) and `div.topbar` (mobile), so `main` is stable. */
  .railshell:not(.is-mobile) {
    display: grid;
    grid-template-columns: minmax(200px, 260px) 1fr;
    gap: 1.25rem;
    align-items: start;
  }
  .rail {
    /* PANEL CHROME — the contained look from `.chat-sidebar-floating`. */
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    padding: 0.6rem;
    /* The rail owns its OWN scroll region (AC20) — a long facet list scrolls
       here without moving the main pane. */
    overflow-y: auto;
    /* Sticky (NOT fixed): the panel floats beside the main content the way
       Chat's fixed sidebar does, but as an in-flow child. `top` re-clears the
       header on scroll (matching first-paint position); the page frame's
       `padding-top: 5.5rem` already supplies the initial clearance, so this is
       NOT a second offset (contract §3). `max-height` bounds the panel to the
       viewport minus the header band minus the bottom gutter so it can never
       grow past the screen — this gives MemoryFilterRail's `height: 100%`
       tag-scroll a real bounded height to resolve against (contract §4c). */
    position: sticky;
    top: var(--header-clearance);
    max-height: calc(100dvh - var(--header-clearance) - 1.5rem);
    box-sizing: border-box;
  }
  .main {
    min-width: 0;
    min-height: 0;
    box-sizing: border-box;
  }

  /* ---- Mobile: a top bar (slotted content + Filters trigger row), the main
     pane below it, and an anchored rounded dropdown that drops from the
     trigger when it's hit (Sidebar idiom). */
  .railshell.is-mobile {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .topbar {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    box-sizing: border-box;
  }
  /* The positioning context the dropdown anchors to — wraps the trigger row so
     the sheet drops directly under the button (not under the search/chips). */
  .trigger-anchor {
    position: relative;
    box-sizing: border-box;
  }
  .filters-trigger {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.55rem;
    /* HIG minimum 44px touch target (codebase convention; AC21). */
    min-height: 44px;
    padding: 0.5rem 0.85rem;
    /* Rounded contained card row (Sidebar `.trigger` look). The `--bg-card`
       surface makes the bar read as a panel, not a bare button. */
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    touch-action: manipulation;
    transition: background var(--transition-fast), border-color var(--transition-fast);
  }
  .filters-trigger:hover {
    background: var(--bg-tertiary);
    border-color: var(--border-primary);
  }
  .filters-trigger:focus-visible {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 1px var(--accent-glow);
  }
  .filters-glyph {
    font-family: var(--font-mono);
    font-size: 1rem;
    line-height: 1;
    color: var(--text-tertiary);
  }

  /* ---- Anchored dropdown sheet (mobile) — Sidebar's `.dropdown` look: a
     rounded `--bg-card` card that drops just below the trigger row, spanning
     gutter-to-gutter. NOT a fixed full-height drawer and NO dark backdrop —
     the dialog semantics are carried by role=dialog + Escape + focus-trap +
     outside-pointerdown in the script, not by a visual scrim. */
  .sheet {
    position: absolute;
    top: calc(100% + 0.4rem);
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    /* Viewport minus the header band + a margin; the rail list scrolls inside
       while the panel stays bounded to the screen. */
    max-height: calc(100dvh - 8rem);
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    z-index: 20;
    box-sizing: border-box;
  }
  .sheet:focus-visible {
    outline: none;
  }
  .sheet-rail {
    /* The sheet body scrolls independently of the page (AC20 carried into the
       mobile surface). */
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1rem;
    box-sizing: border-box;
  }
</style>
