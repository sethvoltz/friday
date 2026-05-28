/**
 * FOUC script drift-detection test — FRI-124 AC #31.
 *
 * The FOUC script must duplicate the palette metadata (kind +
 * themeColor) inline because it runs synchronously in `<head>` before
 * any module loader is available. This test catches the case where a
 * palette is added to `palettes.ts` but the inline FOUC duplicate
 * isn't updated — the build fails at CI before merge.
 *
 * Strategy: parse the inline `P = { ... }` and `D = { ... }` literals
 * out of the FOUC_SCRIPT string via regex, JSON.parse them, and
 * deep-equal against the canonical PALETTES (metadata-only) and
 * DEFAULTS from `palettes.ts`.
 */

import { describe, expect, it } from "vitest";
import { FOUC_SCRIPT } from "./foucScript";
import { DEFAULTS, PALETTES, type PaletteEntry } from "./palettes";

/** Parse the inline `var X = { ... };` JSON-literal that the FOUC script
 *  carries for `X = "P"` (palette metadata) and `X = "D"` (defaults). */
function parseInline<T>(varName: string): T {
  const escaped = varName.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  // The literal sits between `var X =` and the trailing `;`.
  // FOUC_SCRIPT is hand-maintained; the regex assumes the format
  // `var <name> = {…};` with a single trailing `;`.
  const re = new RegExp(`var\\s+${escaped}\\s*=\\s*(\\{[^}]*(?:\\}[^;]*)*\\})\\s*;`);
  const m = FOUC_SCRIPT.match(re);
  if (!m) throw new Error(`Could not parse inline 'var ${varName} = ...' from FOUC_SCRIPT`);
  return JSON.parse(m[1]) as T;
}

describe("FOUC script — drift detection (AC #31)", () => {
  it("the inline P literal matches PALETTES metadata (kind + themeColor)", () => {
    const inlineP = parseInline<Record<string, { kind: string; themeColor: string }>>("P");
    const canonical = Object.fromEntries(
      Object.entries(PALETTES).map(([name, entry]: [string, PaletteEntry]) => [
        name,
        { kind: entry.kind, themeColor: entry.themeColor },
      ]),
    );
    expect(inlineP).toEqual(canonical);
  });

  it("the inline D literal matches DEFAULTS", () => {
    const inlineD = parseInline<Record<string, string>>("D");
    expect(inlineD).toEqual({ light: DEFAULTS.light, dark: DEFAULTS.dark });
  });

  it("every name in inline D references a palette in inline P", () => {
    const inlineP = parseInline<Record<string, unknown>>("P");
    const inlineD = parseInline<Record<string, string>>("D");
    for (const slot of Object.keys(inlineD)) {
      const name = inlineD[slot];
      expect(name in inlineP).toBe(true);
    }
  });
});

describe("FOUC script — shape sanity", () => {
  it("is a single IIFE wrapped in try/catch", () => {
    expect(FOUC_SCRIPT.startsWith("(function(){")).toBe(true);
    expect(FOUC_SCRIPT.trim().endsWith("})();")).toBe(true);
    // The outer try MUST be present so a broken payload doesn't throw
    // and break page load.
    expect(FOUC_SCRIPT).toMatch(/try\s*\{/);
    expect(FOUC_SCRIPT).toMatch(/catch\s*\(e\)\s*\{\}/);
  });

  it("reads the documented localStorage key", () => {
    expect(FOUC_SCRIPT).toContain('"friday:theme"');
  });

  it("consults prefers-color-scheme via matchMedia", () => {
    expect(FOUC_SCRIPT).toContain("(prefers-color-scheme: dark)");
  });

  it("writes html.style.colorScheme, theme-color meta, and palette + dark classes", () => {
    expect(FOUC_SCRIPT).toContain("style.colorScheme");
    expect(FOUC_SCRIPT).toContain('"theme-color"');
    expect(FOUC_SCRIPT).toContain('classList.add("palette-"');
    expect(FOUC_SCRIPT).toContain('classList.add("dark")');
    expect(FOUC_SCRIPT).toContain('classList.remove("dark")');
  });
});
