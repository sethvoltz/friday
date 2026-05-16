/**
 * Dashboard theme tracking, observable for downstream components that need
 * to react when the user toggles between light and dark.
 *
 * mode-watcher owns the authoritative theme state — its pre-paint head
 * script and `<ModeWatcher />` component add/remove a `dark` class on the
 * root `<html>` element. Any component that needs to *react* to a theme
 * change (rather than just being styled by it via CSS variables) can
 * import `theme.version` from this module and read it inside a `$effect` —
 * the version bumps once per class mutation on `<html>`, so effects that
 * depend on it re-fire and can re-stamp any color values they baked into
 * output.
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
    attributeFilter: ["class"],
  });
}

export const theme = {
  /** Increments every time the `<html>` class list mutates (which is how
   *  mode-watcher signals a theme change). Read inside a `$effect` to make
   *  that effect re-fire on theme toggles. */
  get version(): number {
    ensureObserver();
    return _themeVersion;
  },
  /** Current theme, derived directly from the DOM. SSR-safe (returns
   *  "dark" when document is not available — mode-watcher defaults to
   *  system, but during SSR we can't know what that resolves to, and
   *  most app surfaces are designed dark-first). */
  get current(): "light" | "dark" {
    if (typeof document === "undefined") return "dark";
    ensureObserver();
    return document.documentElement.classList.contains("dark")
      ? "dark"
      : "light";
  },
};
