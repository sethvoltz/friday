/**
 * Resolve the authoritative chat send-target agent from the current URL.
 *
 * The URL (`/sessions/[agent]`, or `/` for the default `friday` agent) is the
 * single source of truth for who the user is talking to. This is deliberately
 * preferred over the `chat.focusedAgent` signal at send time: `focusedAgent`
 * is updated by a post-navigation `$effect` in `ChatShell.svelte` and can
 * therefore *lag* the route during/right-after a navigation. A send issued in
 * that window would otherwise be stamped with the previously-viewed agent and
 * silently misrouted (FRI-72 — confirmed root cause of a SEV-0 message loss).
 *
 * Returns the resolved agent name, or `null` when the pathname is not a live
 * chat route (e.g. settings pages) — callers should fall back to the focused
 * agent in that case, since there's no route to be authoritative.
 */
export function resolveSendTargetAgent(pathname: string): string | null {
  if (pathname === "/") return "friday";
  if (pathname.startsWith("/sessions/")) {
    // `/sessions/<agent>` and `/sessions/<agent>/<session>` both put the
    // agent in segment [2] of the split (split[0] === "" for the leading "/").
    const raw = pathname.split("/")[2] ?? "";
    if (!raw) return null;
    const decoded = decodeURIComponent(raw);
    // Defensive: an agent name must be a single path segment. An encoded
    // path that decodes to contain a `/` (e.g. `a%2Fb` → `a/b`) is not a
    // valid agent identifier — refuse to treat it as authoritative rather
    // than stamping a send/overlay with a bogus, slash-bearing agent name.
    // Not reachable from a live chat route today, but cheap robustness.
    if (decoded.includes("/")) return null;
    return decoded;
  }
  return null;
}
