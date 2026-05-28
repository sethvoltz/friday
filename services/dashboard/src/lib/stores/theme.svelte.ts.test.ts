/**
 * Runtime theme-store tests — FRI-124.
 *
 * Tests the pure `ThemeStore` class in isolation. No DOM, no Zero, no
 * matchMedia — the store's setters are pure functions of its `$state`,
 * and the `$derived` `activePalette` / `activeKind` re-resolve
 * automatically. The binder's DOM + Zero side-effects are integration
 * surface, covered by Playwright (AC #10, #11, #12, #27).
 */

import { describe, expect, it } from "vitest";
import { ThemeStore, resolveActivePalette, type Theme } from "./theme.svelte";

describe("resolveActivePalette (pure)", () => {
  it("Single returns picks.single when set", () => {
    const theme: Theme = {
      kind: "single",
      picks: { single: "dusk", light: null, dark: null },
    };
    expect(resolveActivePalette(theme, "light")).toBe("dusk");
    expect(resolveActivePalette(theme, "dark")).toBe("dusk");
  });

  it("Single falls back to DEFAULTS[mode] when picks.single is null", () => {
    const theme: Theme = {
      kind: "single",
      picks: { single: null, light: null, dark: null },
    };
    expect(resolveActivePalette(theme, "light")).toBe("dawn");
    expect(resolveActivePalette(theme, "dark")).toBe("dusk");
  });

  it("Sync uses picks[mode] when set", () => {
    const theme: Theme = {
      kind: "sync",
      picks: { single: null, light: "dawn", dark: "dusk" },
    };
    expect(resolveActivePalette(theme, "light")).toBe("dawn");
    expect(resolveActivePalette(theme, "dark")).toBe("dusk");
  });

  it("Sync allows a light-kind palette in the dark slot (no constraint)", () => {
    // GitHub-style behavior: any palette can occupy any slot. A user
    // who picks Dawn for the dark slot sees Dawn at night.
    const theme: Theme = {
      kind: "sync",
      picks: { single: null, light: "dawn", dark: "dawn" },
    };
    expect(resolveActivePalette(theme, "dark")).toBe("dawn");
  });

  it("Sync slot fallback uses DEFAULTS[mode] when the slot pick is null", () => {
    const theme: Theme = {
      kind: "sync",
      picks: { single: null, light: null, dark: null },
    };
    expect(resolveActivePalette(theme, "light")).toBe("dawn");
    expect(resolveActivePalette(theme, "dark")).toBe("dusk");
  });
});

describe("ThemeStore — Single/Sync semantics (AC #13)", () => {
  it("toggling kind preserves the other branch's picks", () => {
    const store = new ThemeStore();
    store.setKind("sync");
    store.setSlotPick("light", "dawn");
    store.setSlotPick("dark", "dusk");

    // Round-trip: sync → single → sync. Slot picks must survive.
    store.setKind("single");
    store.setSinglePick("dawn");
    expect(store.activePalette).toBe("dawn"); // Single mode active

    store.setKind("sync");
    expect(store.config.picks.light).toBe("dawn");
    expect(store.config.picks.dark).toBe("dusk");
    expect(store.config.picks.single).toBe("dawn"); // Single pick also preserved
  });

  it("toggling kind multiple times preserves all three picks independently", () => {
    // Stronger version of AC #13 — the three pick fields are
    // independent state slots; nothing collapses them.
    const store = new ThemeStore();
    store.setKind("single");
    store.setSinglePick("dusk");
    store.setKind("sync");
    store.setSlotPick("light", "dawn");
    store.setSlotPick("dark", "dawn"); // intentionally light-kind in dark slot
    store.setKind("single");

    expect(store.config.picks.single).toBe("dusk");
    expect(store.config.picks.light).toBe("dawn");
    expect(store.config.picks.dark).toBe("dawn");
  });
});

describe("ThemeStore — Sync follows system mode (AC #14)", () => {
  it("activePalette toggles between light and dark slot when system mode flips", () => {
    const store = new ThemeStore();
    store.setKind("sync");
    store.setSlotPick("light", "dawn");
    store.setSlotPick("dark", "dusk");

    store.setSystemMode(false); // prefers-color-scheme: light
    expect(store.activePalette).toBe("dawn");

    store.setSystemMode(true); // prefers-color-scheme: dark
    expect(store.activePalette).toBe("dusk");

    store.setSystemMode(false);
    expect(store.activePalette).toBe("dawn");
  });

  it("Single mode ignores system mode (activePalette stays constant)", () => {
    const store = new ThemeStore();
    store.setKind("single");
    store.setSinglePick("dusk");

    store.setSystemMode(false);
    expect(store.activePalette).toBe("dusk");
    store.setSystemMode(true);
    expect(store.activePalette).toBe("dusk");
  });
});

describe("ThemeStore — unset picks fall back to defaults (AC #15)", () => {
  it("Single with no pick + system=dark → activePalette = dusk", () => {
    const store = new ThemeStore();
    store.setKind("single");
    store.setSystemMode(true);
    expect(store.config.picks.single).toBeNull();
    expect(store.activePalette).toBe("dusk");
  });

  it("Single with no pick + system=light → activePalette = dawn", () => {
    const store = new ThemeStore();
    store.setKind("single");
    store.setSystemMode(false);
    expect(store.activePalette).toBe("dawn");
  });

  it("Sync with no slot picks → activePalette follows DEFAULTS by system mode", () => {
    const store = new ThemeStore();
    store.setKind("sync");
    // (no setSlotPick calls)
    store.setSystemMode(false);
    expect(store.activePalette).toBe("dawn");
    store.setSystemMode(true);
    expect(store.activePalette).toBe("dusk");
  });

  it("Sync with only the light slot picked → dark slot falls back to default", () => {
    const store = new ThemeStore();
    store.setKind("sync");
    store.setSlotPick("light", "dusk");
    store.setSystemMode(false);
    expect(store.activePalette).toBe("dusk"); // explicit pick
    store.setSystemMode(true);
    expect(store.activePalette).toBe("dusk"); // unset → default[dark]=dusk
  });
});

describe("ThemeStore — activeKind tracks active-palette kind, not system mode", () => {
  it("Single + light-kind palette + system=dark → activeKind = 'light'", () => {
    // The critical "Dawn in dark slot at night" case: the active
    // palette's intrinsic kind drives the .dark class, the colorScheme
    // signal, and the kind-default sub-themes. System mode is only one
    // input to the resolver; it does NOT bypass palette kind.
    const store = new ThemeStore();
    store.setKind("single");
    store.setSinglePick("dawn");
    store.setSystemMode(true);
    expect(store.activePalette).toBe("dawn");
    expect(store.activeKind).toBe("light");
  });

  it("Single + dark-kind palette + system=light → activeKind = 'dark'", () => {
    const store = new ThemeStore();
    store.setKind("single");
    store.setSinglePick("dusk");
    store.setSystemMode(false);
    expect(store.activeKind).toBe("dark");
  });

  it("Sync + Dawn in both slots → activeKind = 'light' regardless of system mode", () => {
    const store = new ThemeStore();
    store.setKind("sync");
    store.setSlotPick("light", "dawn");
    store.setSlotPick("dark", "dawn");
    store.setSystemMode(false);
    expect(store.activeKind).toBe("light");
    store.setSystemMode(true);
    expect(store.activeKind).toBe("light");
  });
});

describe("ThemeStore — applyPartial (hydrate path)", () => {
  it("applies kind and picks from a partial payload", () => {
    const store = new ThemeStore();
    store.applyPartial({
      kind: "single",
      picks: { single: "dusk", light: "dawn", dark: "dusk" },
    });
    expect(store.config.kind).toBe("single");
    expect(store.config.picks).toEqual({
      single: "dusk",
      light: "dawn",
      dark: "dusk",
    });
  });

  it("ignores invalid kind values silently", () => {
    const store = new ThemeStore();
    store.applyPartial({
      // @ts-expect-error — testing runtime tolerance for bad input
      kind: "garbage",
    });
    expect(store.config.kind).toBe("sync"); // default unchanged
  });

  it("ignores invalid palette names silently (resolver tolerance)", () => {
    const store = new ThemeStore();
    store.applyPartial({
      picks: {
        single: "not-a-real-palette",
        light: null,
        dark: null,
      },
    });
    expect(store.config.picks.single).toBeNull();
  });

  it("a no-op on null input", () => {
    const store = new ThemeStore();
    const before = store.config;
    store.applyPartial(null);
    expect(store.config).toEqual(before);
  });
});
