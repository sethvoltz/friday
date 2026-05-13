/**
 * Initial-page-size heuristic (FIX_FORWARD 3.8).
 *
 * Picks a sensible default `limit` for paginated history fetches based on
 * the client's viewport width and reported network class. The aim is to
 * keep first-paint quick on slow links / small screens without leaving
 * desktop users on broadband repeatedly scroll-up-loading.
 *
 *   - Mobile-ish viewport (window.innerWidth < 768px) → 10
 *   - Slow connection (`navigator.connection.effectiveType` ∈
 *     {'slow-2g', '2g'}) → 10 (overrides desktop default)
 *   - Otherwise → 25
 *
 * The server clamps incoming `limit` to ≤200 regardless (FIX_FORWARD 1.8),
 * so a misbehaving client can't blow up history fetches.
 */

const SMALL_VIEWPORT_LIMIT = 10;
const DEFAULT_LIMIT = 25;
const MOBILE_BREAKPOINT_PX = 768;

interface NetworkInformationLike {
  effectiveType?: string;
}

/**
 * Returns the initial page size to use for the next history fetch. Safe to
 * call during SSR — falls back to the default when window / navigator are
 * unavailable.
 */
export function initialPageSize(): number {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return DEFAULT_LIMIT;
  }
  const nav = navigator as { connection?: NetworkInformationLike };
  const ect = nav.connection?.effectiveType;
  if (ect === "slow-2g" || ect === "2g") return SMALL_VIEWPORT_LIMIT;
  if (window.innerWidth < MOBILE_BREAKPOINT_PX) return SMALL_VIEWPORT_LIMIT;
  return DEFAULT_LIMIT;
}
