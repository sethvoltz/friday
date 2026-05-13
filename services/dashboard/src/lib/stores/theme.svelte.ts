/**
 * Dashboard theme tracking, observable for downstream components that need
 * to react when the user toggles between light and dark.
 *
 * The authoritative theme state lives in `+layout.svelte`, which writes it
 * to `<html data-theme="...">`. Any component that needs to *react* to a
 * theme change (rather than just being styled by it via CSS variables) can
 * import `themeVersion` from this module and read it inside a `$effect` —
 * the version bumps once per `data-theme` mutation, so effects that depend
 * on it re-fire and can re-stamp any color values they baked into output.
 *
 * The observer is set up lazily on first read (server-side / SSR-safe) and
 * is a module-level singleton, so N consumers share one MutationObserver.
 *
 * Concrete consumer: Markdown.svelte's mermaid mount path — mermaid bakes
 * theme colors into the SVG at render time, so live re-skinning requires
 * tearing down and re-running every diagram against the new theme.
 */

let _themeVersion = $state(0);
let _observer: MutationObserver | null = null;

function ensureObserver() {
  if (_observer || typeof document === "undefined") return;
  _observer = new MutationObserver(() => {
    _themeVersion++;
  });
  _observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

export const theme = {
  /** Increments every time `<html data-theme>` mutates. Read inside a
   *  `$effect` to make that effect re-fire on theme toggles. */
  get version(): number {
    ensureObserver();
    return _themeVersion;
  },
  /** Current theme, derived directly from the DOM. SSR-safe (returns
   *  "dark" when document is not available, matching the layout's
   *  default state). */
  get current(): "light" | "dark" {
    if (typeof document === "undefined") return "dark";
    ensureObserver();
    return document.documentElement.getAttribute("data-theme") === "light"
      ? "light"
      : "dark";
  },
};
