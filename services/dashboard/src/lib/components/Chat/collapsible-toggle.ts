// Pure, DOM-free derivation for CollapsibleSection's "smart toggle" (FRI-137).
//
// CollapsibleSection clamps collapsed content to `collapsedMaxHeight` and
// renders a `+`/`−` disclosure control. Before FRI-137 the control was
// ALWAYS rendered — even for content that already fits within the cap, which
// produced a useless expand/collapse affordance (a 1–2 line file edit got a
// toggle that toggled nothing visible). This helper is the pure seam that
// decides whether the toggle (and the clamp) should appear at all.
//
// Extracted to its own module so the dashboard's node/forks vitest pool (no
// DOM) can unit-test the derivation directly; the actual `scrollHeight` read
// and the rendered visual cases are pinned in Playwright.

/**
 * Whether CollapsibleSection should render its disclosure control + apply the
 * collapsed-height clamp.
 *
 * The decision is purely "is there more content than the collapsed cap can
 * show?" — i.e. `measuredHeight > collapsedMaxHeight`. This is measured from
 * the body's `scrollHeight`, which reports the FULL content height regardless
 * of whether the `max-height` clamp is currently applied, so the signal is
 * stable across open/closed: a section that overflows keeps its toggle whether
 * expanded or collapsed, and one that fits never shows a toggle (even with
 * `startOpen=true`, the common default for file-edit/todo blocks).
 *
 * `measuredHeight === 0` (pre-measure, before the first layout/ResizeObserver
 * tick) reads as "not yet known to overflow" → no toggle. The post-mount
 * measure flips it on if the content really overflows, so the toggle settles
 * after first paint rather than flashing on for fits-content sections.
 *
 * @param open is accepted for call-site symmetry with the component's
 *   reactive inputs but does NOT force the toggle on — `scrollHeight` already
 *   captures the full height while expanded, so an open-but-fitting section
 *   correctly has no toggle.
 */
export function shouldShowToggle(
  measuredHeight: number,
  collapsedMaxHeight: number,
  _open?: boolean,
): boolean {
  void _open;
  return measuredHeight > collapsedMaxHeight;
}
