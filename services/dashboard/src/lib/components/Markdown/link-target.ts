/**
 * Link-target policy for rendered markdown anchors (FRI-131).
 *
 * `processLinks()` in `Markdown.svelte` walks the rendered DOM and, for every
 * `<a href>`, decides whether the link should open in a new tab. The decision
 * itself — "is this an absolute URL?" — is pure string logic, extracted here so
 * it can be unit-tested without a DOM (the dashboard vitest pool runs in plain
 * node, no jsdom). The DOM-walking glue stays in the component; this module is
 * the load-bearing branch it calls.
 *
 * Absolute URLs (a `scheme:` prefix or a protocol-relative `//`) open in a new
 * tab so clicking an external reference (e.g. a GitHub PR link an agent emitted
 * via the `pr-links` protocol) doesn't replace the dashboard. Relative paths
 * (`/foo`, `./foo`, `#hash`) stay in the same tab so internal SvelteKit
 * navigation keeps working.
 */
export const ABSOLUTE_HREF = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/** Attributes applied to an anchor that should open in a new tab. */
export interface NewTabAttrs {
  target: "_blank";
  rel: "noopener noreferrer";
}

/** True when an href is absolute and should therefore open in a new tab. */
export function isAbsoluteHref(href: string): boolean {
  return ABSOLUTE_HREF.test(href);
}

/**
 * The `target`/`rel` attributes `processLinks` should set on an anchor, or
 * `null` when the link is relative and should stay in the same tab.
 */
export function linkTargetAttrs(href: string): NewTabAttrs | null {
  return isAbsoluteHref(href) ? { target: "_blank", rel: "noopener noreferrer" } : null;
}
