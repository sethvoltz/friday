/**
 * iOS PWA external-link override.
 *
 * Since iOS 16.4 the in-app Safari View Controller-like overlay slides up
 * for every `target="_blank"` / out-of-scope navigation from a standalone
 * PWA — the user can't get to the real Safari with their bookmarks /
 * extensions / tabs / login state without dismissing the sheet and using
 * Share → "Open in Safari" manually. `rel="external"` / `rel="noopener"`
 * do not change the routing. The `x-safari-https:` URL scheme works on
 * iOS 15 / 17 / 18 but is broken on iOS 16, exactly the version range
 * where this regression first appeared.
 *
 * The reliable workaround is to intercept the click and call
 * `window.open(url, "_system")`. `_system` is non-standard (it originates
 * in Cordova's InAppBrowser plugin) but Safari in standalone mode treats
 * unknown target names as a hint to hand off to the system browser; the
 * URL opens in native Safari and the PWA stays running in its own task,
 * so a swipe-back from the app switcher returns the user to the PWA's
 * exact state.
 *
 * References:
 *   - https://www.codelessgenie.com/blog/ios-pwa-how-to-open-external-link-on-mobile-default-safari-not-in-app-browser/
 *   - https://gist.github.com/kylebarrow/1042026
 *   - https://firt.dev/notes/pwa-ios/  (iOS 12.2+ in-app browser for out-of-scope links)
 */

import { isAbsoluteHref } from "$lib/components/Markdown/link-target";

/**
 * True iff the page is running as an installed iOS PWA in standalone
 * mode. `navigator.standalone` is an iOS-only flag (still present in
 * 2026) that is `true` exactly for "Add to Home Screen" PWAs on iOS;
 * desktop, Android, in-browser-tab Safari, and standalone PWAs on other
 * OSes all return `undefined`. We deliberately do NOT fall back to
 * `(display-mode: standalone)` because installed Android and desktop
 * PWAs also match that query and don't need the override.
 */
export function isIOSStandalonePWA(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

/**
 * Pure decision: returns the canonicalized absolute href that should be
 * handed off to the system browser, or `null` if the click should fall
 * through to default behavior. Extracted as a pure function so the
 * decision logic is testable in the dashboard's DOM-less node vitest
 * pool — parallels `linkTargetAttrs` in `Markdown/link-target.ts`.
 *
 * Intercept iff: (1) we're in iOS standalone PWA mode AND (2) the href
 * is absolute AND (3) the resolved origin differs from the page origin.
 * Same-origin absolute hrefs are left alone so internal navigation
 * keeps using the PWA's own window.
 */
export function decideExternalLinkIntercept(
  href: string,
  pageOrigin: string,
  iosStandalone: boolean,
): string | null {
  if (!iosStandalone) return null;
  if (!isAbsoluteHref(href)) return null;
  let url: URL;
  try {
    url = new URL(href, pageOrigin);
  } catch {
    return null;
  }
  if (url.origin === pageOrigin) return null;
  return url.href;
}

/** Minimal anchor shape the click handler needs — kept structural so
 *  tests don't have to construct real DOM nodes. */
interface AnchorLike {
  getAttribute(name: string): string | null;
}

/** Loosened target shape so a real `MouseEvent` (whose `target` is
 *  `EventTarget | null`) can be passed directly. The runtime guard
 *  inside `handleExternalLinkClick` narrows to objects exposing
 *  `closest`, which on a click bubble-target is the real DOM Element. */
interface ClickLike {
  preventDefault(): void;
  target: unknown;
}

/**
 * Delegated click handler. Returns `true` iff the click was intercepted
 * (caller can use the return value for instrumentation; in production
 * we just call this in a `click` listener and let it do its thing).
 */
export function handleExternalLinkClick(
  event: ClickLike,
  opts: {
    pageOrigin: string;
    iosStandalone: boolean;
    open: (href: string) => void;
  },
): boolean {
  const target = event.target as
    | { closest?: (selector: string) => AnchorLike | null }
    | null
    | undefined;
  if (!target || typeof target.closest !== "function") return false;
  const anchor = target.closest("a[href]");
  if (!anchor) return false;
  const href = anchor.getAttribute("href");
  if (!href) return false;
  const interceptHref = decideExternalLinkIntercept(
    href,
    opts.pageOrigin,
    opts.iosStandalone,
  );
  if (interceptHref === null) return false;
  event.preventDefault();
  opts.open(interceptHref);
  return true;
}

/**
 * Open a URL in the iOS system Safari app rather than the in-app
 * overlay. See module header for why `_system` is the chosen target.
 */
export function openInSystemBrowser(href: string): void {
  window.open(href, "_system");
}
