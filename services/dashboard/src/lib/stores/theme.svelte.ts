/**
 * Theming runtime store — FRI-124.
 *
 * Replaces the previous `mode-watcher`-driven, MutationObserver-based
 * design. The new model has three pieces in one file:
 *
 *   1. **Pure resolver** — `resolveActivePalette(theme, mode)` is a
 *      total function from `{ kind, picks }` + resolved mode to a
 *      palette name. No DOM, no Zero, no `$state`. Used everywhere the
 *      derivation is needed; trivial to unit-test in isolation.
 *
 *   2. **ThemeStore class** — owns the user-facing `Theme` (kind +
 *      picks) and the system's resolved mode (`light` | `dark`) as
 *      `$state`. Exposes pure-API setters that the UI calls; computes
 *      `activePalette` and `activeKind` via `$derived`. No side effects
 *      live here — applying classes to `<html>` or persisting to
 *      localStorage are the binder's job.
 *
 *   3. **`bindTheme(zeroSync)`** — wires the store to real-world
 *      side-effect surfaces inside a single `$effect.root`. Called once
 *      from `+layout.svelte` after mount. Responsible for:
 *        - hydrating the store from `localStorage` (FOUC-script's
 *          last-known cache) and then from Zero's canonical row;
 *        - subscribing to `zeroSync.settings` and pushing updates into
 *          the store on every reactive change;
 *        - tracking `prefers-color-scheme` via `matchMedia` and pushing
 *          the resolved mode into the store;
 *        - applying DOM side effects (the `.palette-<name>` and `.dark`
 *          classes on `<html>`, `<html>.style.colorScheme`, and the
 *          `<meta name="theme-color">` content) in a `$effect` that
 *          re-fires whenever the active palette changes;
 *        - mirroring the latest `Theme` to `localStorage['friday:theme']`
 *          so the next page load's FOUC script has fresh data.
 *
 * The store is exported as a module-level singleton: `theme`. Components
 * subscribe via `$effect` to `theme.activePalette` or `theme.activeKind`.
 * UI elements that change the user's selection call the setters, which
 * also fire the Zero mutator to persist canonically.
 *
 * SSR safety: every `window` / `document` / `localStorage` touch sits
 * behind a `typeof` guard. The store class can be instantiated in
 * Node-only tests; the binder is a no-op when there's no DOM.
 */

import {
  DEFAULTS,
  PALETTES,
  type PaletteKind,
  type PaletteName,
  isPaletteName,
} from "$lib/theme/palettes";

/** The user's two configuration modes for the Appearance card.
 *  - **single**: one palette wins regardless of system mode.
 *  - **sync**: picks per slot (light, dark); active follows system mode. */
export type ThemeKind = "single" | "sync";

/** The three slots' palette picks. Each is independent — `null` means
 *  the user hasn't explicitly chosen, and the resolver falls back to a
 *  built-in default. */
export interface ThemePicks {
  single: PaletteName | null;
  light: PaletteName | null;
  dark: PaletteName | null;
}

export interface Theme {
  kind: ThemeKind;
  picks: ThemePicks;
}

/** Pure resolver — given the user's `Theme` and the resolved system
 *  mode, return the palette name that should render right now. */
export function resolveActivePalette(theme: Theme, resolvedMode: PaletteKind): PaletteName {
  if (theme.kind === "single") {
    return theme.picks.single ?? DEFAULTS[resolvedMode];
  }
  return theme.picks[resolvedMode] ?? DEFAULTS[resolvedMode];
}

/** localStorage key under which the FOUC script reads the cached
 *  `Theme`. The runtime store mirrors the canonical Zero value here on
 *  every change so the next page load resolves the active palette
 *  before paint. */
export const THEME_STORAGE_KEY = "friday:theme";

/** Coerce an unknown localStorage value into the partial Theme shape.
 *  Anything malformed is ignored; the caller falls back to defaults. */
function readStoredTheme(): Partial<Theme> | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Partial<Theme>;
  } catch {
    return null;
  }
}

function writeStoredTheme(theme: Theme): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
  } catch {
    // SecurityError / QuotaExceededError — non-fatal; FOUC will just
    // fall back to defaults on next load.
  }
}

/** Coerce an arbitrary string from Zero / localStorage into a valid
 *  PaletteName, or `null` if it doesn't name a palette in the catalog.
 *  Tolerating unknown names is intentional — see palettes.ts notes. */
function toPaletteName(value: unknown): PaletteName | null {
  return isPaletteName(value) ? value : null;
}

/** Coerce an arbitrary value into a valid ThemeKind, or null. */
function toThemeKind(value: unknown): ThemeKind | null {
  return value === "single" || value === "sync" ? value : null;
}

/** The pure store class — `$state` fields + `$derived` accessors +
 *  imperative setters. Side-effect-free; tested directly in
 *  `theme.svelte.ts.test.ts`. The binder consumes this. */
export class ThemeStore {
  #kind: ThemeKind = $state("sync");
  #single: PaletteName | null = $state(null);
  #light: PaletteName | null = $state(null);
  #dark: PaletteName | null = $state(null);
  #systemDark: boolean = $state(false);

  /** Pure resolver output. */
  readonly activePalette: PaletteName = $derived(
    resolveActivePalette(
      { kind: this.#kind, picks: { single: this.#single, light: this.#light, dark: this.#dark } },
      this.#systemDark ? "dark" : "light",
    ),
  );

  /** Intrinsic kind of the currently-active palette. Drives the `.dark`
   *  class on `<html>` and the kind-default sub-themes (Shiki, Mermaid).
   *  Note: this is the *active palette's* kind, NOT the user's resolved
   *  system mode. A user on Sync with Mode=dark but slot palette = Dawn
   *  gets `activeKind === 'light'`. */
  readonly activeKind: PaletteKind = $derived(PALETTES[this.activePalette].kind);

  get kind(): ThemeKind {
    return this.#kind;
  }
  get config(): Theme {
    return {
      kind: this.#kind,
      picks: { single: this.#single, light: this.#light, dark: this.#dark },
    };
  }
  /** Read-only access to the resolved system mode the store is tracking.
   *  Drives the Sync-mode resolver branch. */
  get systemMode(): PaletteKind {
    return this.#systemDark ? "dark" : "light";
  }

  /** Toggle Single ↔ Sync. The other branch's picks are preserved
   *  (each pick lives in its own `$state` field). */
  setKind(kind: ThemeKind): void {
    this.#kind = kind;
  }
  /** Set the Single-mode palette pick. Pass `null` to clear (resolver
   *  falls back to default). */
  setSinglePick(name: PaletteName | null): void {
    this.#single = name;
  }
  /** Set the Sync-mode palette pick for one slot. */
  setSlotPick(slot: PaletteKind, name: PaletteName | null): void {
    if (slot === "light") this.#light = name;
    else this.#dark = name;
  }
  /** Update the tracked system mode. Called by the matchMedia listener
   *  in the binder; exposed for tests that mock `prefers-color-scheme`. */
  setSystemMode(dark: boolean): void {
    this.#systemDark = dark;
  }

  /** Bulk-apply a partial theme — used by both the localStorage hydrate
   *  and the Zero-row reconcile. Tolerates malformed values silently. */
  applyPartial(partial: Partial<Theme> | null): void {
    if (!partial) return;
    const kind = toThemeKind(partial.kind);
    if (kind) this.#kind = kind;
    const picks = partial.picks;
    if (picks && typeof picks === "object") {
      if ("single" in picks) this.#single = toPaletteName(picks.single);
      if ("light" in picks) this.#light = toPaletteName(picks.light);
      if ("dark" in picks) this.#dark = toPaletteName(picks.dark);
    }
  }
}

/** Module-level singleton — components import this directly. */
export const theme = new ThemeStore();

/* ---------------- Binder (side-effect installer) ---------------- */

/** Shape of the Zero settings row this binder reads. Mirrors
 *  `ZeroSettingsRow` from `zero.svelte.ts` plus the new theme columns
 *  introduced in FRI-124. Kept structural here to avoid a circular
 *  import with the Zero store. */
interface ZeroSettingsLike {
  theme_kind?: string | null;
  theme_palette_single?: string | null;
  theme_palette_light?: string | null;
  theme_palette_dark?: string | null;
}

interface ZeroSyncLike {
  settings: readonly ZeroSettingsLike[];
}

/** Apply a Zero settings row to the store. Treats `null` / missing
 *  values as "unset" (resolver default fires); validates strings
 *  through the palette catalog. */
function applyZeroRow(store: ThemeStore, row: ZeroSettingsLike | undefined): void {
  if (!row) return;
  store.applyPartial({
    kind: toThemeKind(row.theme_kind) ?? undefined,
    picks: {
      single: toPaletteName(row.theme_palette_single),
      light: toPaletteName(row.theme_palette_light),
      dark: toPaletteName(row.theme_palette_dark),
    },
  });
}

/** Apply the active palette to the DOM. Idempotent — safe to call
 *  with no-op inputs. */
function applyDom(palette: PaletteName, kind: PaletteKind): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // Remove any stale palette classes (defensive — the FOUC script may
  // have stamped a different palette on initial paint), then add the
  // active one.
  for (const name of Object.keys(PALETTES)) {
    root.classList.remove(`palette-${name}`);
  }
  root.classList.add(`palette-${palette}`);
  // `.dark` is the kind marker — driven by active-palette kind, NOT by
  // the user's resolved mode. See FRI-124 plan.
  root.classList.toggle("dark", kind === "dark");
  root.style.colorScheme = kind;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", PALETTES[palette].themeColor);
}

/** Bind the theme store to a `zeroSync` instance + the browser's
 *  `prefers-color-scheme` + the DOM. Call once from `+layout.svelte`
 *  inside `onMount`. Returns a `cleanup()` for symmetry with the rest
 *  of the dashboard's binders; SvelteKit's `+layout.svelte` cleanup
 *  fires it on unmount.
 *
 *  SSR-safe: no-op when there's no `window`.
 */
export function bindTheme(zeroSync: ZeroSyncLike): () => void {
  if (typeof window === "undefined") return () => {};

  // Hydrate from the FOUC-script's localStorage cache first. The Zero
  // row may not have replicated yet on first paint; the cache is what
  // the FOUC script already used to stamp the DOM, so the store starts
  // aligned with the on-screen state.
  const cached = readStoredTheme();
  if (cached) theme.applyPartial(cached);

  // Track prefers-color-scheme. The store's $derived activePalette
  // re-resolves automatically when systemDark flips.
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  theme.setSystemMode(mq.matches);
  const onMq = (e: MediaQueryListEvent) => theme.setSystemMode(e.matches);
  // Older Safari uses `addListener`; modern browsers use the
  // EventTarget interface. Prefer the modern path.
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", onMq);
  } else {
    // @ts-expect-error legacy API
    mq.addListener(onMq);
  }

  const cleanups: Array<() => void> = [];
  cleanups.push(() => {
    if (typeof mq.removeEventListener === "function") {
      mq.removeEventListener("change", onMq);
    } else {
      // @ts-expect-error legacy API
      mq.removeListener(onMq);
    }
  });

  const rootEffect = $effect.root(() => {
    // Zero → store: whenever the settings row changes, push the new
    // values into the store. The first row may not exist yet (Zero is
    // still hydrating); the store's defaults remain in effect until it
    // arrives.
    $effect(() => {
      applyZeroRow(theme, zeroSync.settings[0]);
    });

    // Store → DOM + localStorage. Re-fires whenever activePalette or
    // activeKind shifts (which is whenever any of `kind`, `picks`, or
    // `systemDark` changes).
    $effect(() => {
      const palette = theme.activePalette;
      const kind = theme.activeKind;
      applyDom(palette, kind);
      writeStoredTheme(theme.config);
    });
  });
  cleanups.push(rootEffect);

  return () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // best-effort
      }
    }
  };
}

