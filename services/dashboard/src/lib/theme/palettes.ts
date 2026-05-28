/**
 * Palette catalog — the canonical source of truth for what palettes Friday
 * ships and their per-palette metadata. The CSS token bodies live in
 * `palettes.css` (one `.palette-<name> { … }` block per entry here);
 * the runtime store, the FOUC script, and the Appearance settings UI all
 * consume this catalog.
 *
 * Adding a new palette:
 *   1. Add an entry below with `kind`, `themeColor`, and optional
 *      `shikiTheme` / `mermaidTheme` overrides.
 *   2. Add a matching `.palette-<name> { … }` block in `palettes.css`
 *      that defines EVERY token (strict contract — see palettes.test.ts).
 *   3. The FOUC script in `foucScript.ts` carries an inline duplicate of
 *      this catalog's *metadata* (kind + themeColor only). The
 *      `foucScript.test.ts` drift-detection test will fail until you
 *      update that duplicate to match.
 */
export type PaletteKind = "light" | "dark";

export type PaletteEntry = {
  /** Intrinsic palette style. Drives sub-themed renderers (Shiki,
   *  Mermaid), the `.dark` class on `<html>`, `html.style.colorScheme`,
   *  and the `<meta name="theme-color">` choice. NOT a constraint on
   *  which Theme slot the palette can occupy. */
  kind: PaletteKind;
  /** Hex color stamped onto `<meta name="theme-color">` while this
   *  palette is active. Drives the iOS PWA address-bar tint and the
   *  Android task-switcher chrome. Should match the palette's
   *  `--bg-primary`. */
  themeColor: string;
  /** Optional Shiki theme name (e.g. `"nord"`). When unset, falls back
   *  to the kind default: `"catppuccin-latte"` (light) or
   *  `"catppuccin-mocha"` (dark). */
  shikiTheme?: string;
  /** Optional Mermaid theme name (`"default" | "dark" | "forest" |
   *  "neutral" | "base"`). When unset, falls back to the kind default:
   *  `"default"` (light) or `"dark"` (dark). */
  mermaidTheme?: string;
};

export const PALETTES: Record<string, PaletteEntry> = {
  dawn: {
    kind: "light",
    themeColor: "#faf6f1",
  },
  dusk: {
    kind: "dark",
    themeColor: "#0f1219",
  },
};

/** Valid palette names. v1 ships "dawn" and "dusk"; widening to string
 *  keeps the type permissive (the catalog can be extended at runtime).
 *  Use `isPaletteName()` at any boundary where unknown input arrives. */
export type PaletteName = string;

/** Default palette for each slot, used when the user hasn't explicitly
 *  picked. The resolver consults these whenever a slot's pick is unset. */
export const DEFAULTS: Record<PaletteKind, PaletteName> = {
  light: "dawn",
  dark: "dusk",
};

/** Shiki theme name for a palette — explicit override wins; kind-default
 *  otherwise. */
export function shikiThemeFor(name: PaletteName): string {
  const entry = PALETTES[name];
  return entry.shikiTheme ?? (entry.kind === "dark" ? "catppuccin-mocha" : "catppuccin-latte");
}

/** Mermaid theme name for a palette — explicit override wins; kind-default
 *  otherwise. */
export function mermaidThemeFor(name: PaletteName): string {
  const entry = PALETTES[name];
  return entry.mermaidTheme ?? (entry.kind === "dark" ? "dark" : "default");
}

/** Type guard — accepts any string and narrows to PaletteName if it
 *  matches a catalog entry. */
export function isPaletteName(value: unknown): value is PaletteName {
  return typeof value === "string" && value in PALETTES;
}
