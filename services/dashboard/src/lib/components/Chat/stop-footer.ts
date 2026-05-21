/**
 * FRI-95: pure function for the Stop-affordance footer copy.
 *
 * The exact strings rendered for each (status, abortReason) pair are part
 * of the FRI-95 behavioral contract (Part B.3 of the ticket). Extracting
 * them here lets the contract be pinned at the unit-test layer
 * (`stop-footer.test.ts`) — the Svelte template in `ChatMessages.svelte`
 * is then a thin lookup, not a place where the contract can rot.
 *
 * Returns `null` when no footer should render — the caller skips the
 * affordance entirely in that case.
 */
export interface StopFooter {
  /** The user-visible string rendered inside the footer-tag. */
  text: string;
  /** Optional extra class for status-specific styling (e.g. `stopping`). */
  className?: "stopping";
}

export function stopFooter(
  status: string,
  abortReason?: "cooperative" | "forced",
): StopFooter | null {
  switch (status) {
    case "stopping":
      return { text: "Stopping…", className: "stopping" };
    case "aborted":
      return {
        text:
          abortReason === "forced"
            ? "Stopped — worker had to be force-killed"
            : "Stopped",
      };
    case "already_finished":
      return { text: "Already finished" };
    default:
      return null;
  }
}
