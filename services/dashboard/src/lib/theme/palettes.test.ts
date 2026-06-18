import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PALETTES } from "./palettes";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, "palettes.css");
const css = readFileSync(cssPath, "utf8");

/** Extract the CSS custom-property names declared inside a
 *  `.palette-<name> { … }` block. */
function tokensFor(palette: string): Set<string> {
  const escaped = palette.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const blockRe = new RegExp(`\\.palette-${escaped}\\s*\\{([^}]*)\\}`, "m");
  const m = css.match(blockRe);
  if (!m) throw new Error(`No .palette-${palette} block found in palettes.css`);
  const body = m[1];
  const tokens = new Set<string>();
  const declRe = /(--[a-z0-9-]+)\s*:/gi;
  let d: RegExpExecArray | null;
  while ((d = declRe.exec(body))) tokens.add(d[1]);
  return tokens;
}

describe("palette catalog", () => {
  it("PALETTES contains exactly ['dawn', 'dusk', 'phosphor']", () => {
    expect(Object.keys(PALETTES).sort()).toEqual(["dawn", "dusk", "phosphor"]);
  });

  it("every palette name in PALETTES has a matching .palette-<name> CSS block", () => {
    for (const name of Object.keys(PALETTES)) {
      const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      const blockRe = new RegExp(`\\.palette-${escaped}\\s*\\{`, "m");
      expect(css).toMatch(blockRe);
    }
  });

  it("every .palette-<name> block in palettes.css has a matching PALETTES entry", () => {
    const blockNames = new Set<string>();
    const blockRe = /\.palette-([a-z0-9-]+)\s*\{/gim;
    let b: RegExpExecArray | null;
    while ((b = blockRe.exec(css))) blockNames.add(b[1]);
    expect([...blockNames].sort()).toEqual(Object.keys(PALETTES).sort());
  });

  it("every palette declares the same set of tokens (strict contract)", () => {
    const names = Object.keys(PALETTES);
    expect(names.length).toBeGreaterThanOrEqual(2);
    const reference = [...tokensFor(names[0])].sort();
    for (const name of names.slice(1)) {
      expect([...tokensFor(name)].sort()).toEqual(reference);
    }
  });

  it("each palette declares exactly 63 tokens", () => {
    // 49 existing color/shadow tokens migrated from :root + .dark, plus
    // 5 leak-fix tokens (--diff-removed, --diff-added, --toggle-knob,
    // --chart-5, --chart-6), plus --status-compacting (compaction-in-progress
    // sidebar dot) = 55, plus the 8-token Habit color ramp (FRI-169:
    // --habit-empty + --habit-1..7) = 63.
    for (const name of Object.keys(PALETTES)) {
      expect(tokensFor(name).size).toBe(63);
    }
  });

  it("the Habit color ramp (--habit-empty + --habit-1..7) is present in every palette", () => {
    const required = [
      "--habit-empty",
      "--habit-1",
      "--habit-2",
      "--habit-3",
      "--habit-4",
      "--habit-5",
      "--habit-6",
      "--habit-7",
    ];
    for (const name of Object.keys(PALETTES)) {
      const tokens = tokensFor(name);
      for (const r of required) {
        expect(tokens.has(r)).toBe(true);
      }
    }
  });

  it("the 5 leak-fix tokens are present in every palette", () => {
    const required = ["--diff-removed", "--diff-added", "--toggle-knob", "--chart-5", "--chart-6"];
    for (const name of Object.keys(PALETTES)) {
      const tokens = tokensFor(name);
      for (const r of required) {
        expect(tokens.has(r)).toBe(true);
      }
    }
  });

  it("the renamed --chat-aurora-* tokens are present (and old --friday-* names are not)", () => {
    for (const name of Object.keys(PALETTES)) {
      const tokens = tokensFor(name);
      expect(tokens.has("--chat-aurora-1")).toBe(true);
      expect(tokens.has("--chat-aurora-2")).toBe(true);
      expect(tokens.has("--chat-aurora-3")).toBe(true);
      expect(tokens.has("--friday-blue")).toBe(false);
      expect(tokens.has("--friday-purple")).toBe(false);
      expect(tokens.has("--friday-pink")).toBe(false);
    }
  });

  it("--chart-cache is preserved in every palette (per reviewer correction; consumer at dashboard/+page.svelte:1071)", () => {
    for (const name of Object.keys(PALETTES)) {
      expect(tokensFor(name).has("--chart-cache")).toBe(true);
    }
  });
});
