/**
 * Pre-paint FOUC-killer script — FRI-124.
 *
 * Stamped into `<svelte:head>` via `{@html}` in `+layout.svelte`, this
 * script runs synchronously inside `<head>` before any `<body>` markup
 * is parsed. It reads the user's last-known **Theme** from
 * `localStorage["friday:theme"]` (mirror written by the runtime store
 * in `lib/stores/theme.svelte.ts`), resolves the active **Palette**
 * via the same lazy-default semantics as the resolver, and stamps the
 * resolved `.palette-<name>` + `.dark` (if kind is dark) classes on
 * `<html>`, plus `style.colorScheme` and `<meta name="theme-color">`.
 *
 * This is the only place where palette metadata gets duplicated. The
 * **drift-detection test** in `foucScript.test.ts` reads this file as
 * a string, parses the inline `P = {...}` and `D = {...}` literals via
 * regex, and asserts deep equality against the canonical exports from
 * `palettes.ts`. The test fails the build if the duplicate falls out
 * of sync.
 *
 * Why the duplicate exists: this script runs before any module loader
 * (Vite, Svelte, anything). It cannot `import`. The metadata must be
 * embedded inline in the script body. The price is one drift test
 * (cheap); the win is no FOUC and no build-time codegen step.
 *
 * FOUC-killer pattern inspired by mode-watcher (MIT,
 * github.com/svecosystem/mode-watcher).
 */

/**
 * The script body, as a literal string. Embed in `<svelte:head>` via:
 *
 *   <svelte:head>{@html `<script>${FOUC_SCRIPT}</script>`}</svelte:head>
 *
 * Every line of the IIFE is wrapped in a top-level `try { ... } catch
 * (e) {}` so a broken localStorage payload, sandboxed iframe
 * SecurityError, or absent `<meta name="theme-color">` never throws —
 * worst case the page renders with the boot default
 * (`<html class="palette-dusk dark">` from `app.html`).
 */
export const FOUC_SCRIPT = `(function(){
  try {
    var P = {"dawn":{"kind":"light","themeColor":"#faf6f1"},"dusk":{"kind":"dark","themeColor":"#0f1219"},"phosphor":{"kind":"dark","themeColor":"#000000"}};
    var D = {"light":"dawn","dark":"dusk"};
    var KEY = "friday:theme";
    var stored = null;
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) stored = JSON.parse(raw);
    } catch (e) {}
    var kind = (stored && stored.kind === "single") ? "single" : "sync";
    var picks = (stored && stored.picks) || {};
    var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var slot = dark ? "dark" : "light";
    var name;
    if (kind === "single") {
      name = (typeof picks.single === "string" && P[picks.single]) ? picks.single : D[slot];
    } else {
      var slotPick = picks[slot];
      name = (typeof slotPick === "string" && P[slotPick]) ? slotPick : D[slot];
    }
    var meta = P[name] || P[D[slot]];
    var root = document.documentElement;
    for (var k in P) {
      if (Object.prototype.hasOwnProperty.call(P, k)) {
        root.classList.remove("palette-" + k);
      }
    }
    root.classList.add("palette-" + name);
    if (meta.kind === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    root.style.colorScheme = meta.kind;
    var tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute("content", meta.themeColor);
  } catch (e) {}
})();`;
