// Pure status → badge mapping for chat tool blocks (FRI-137).
//
// ToolBlock, MailToolBlock and the file-edit FileDiff header all render the
// same status indicator: a globally-styled `.badge` whose modifier class and
// text are derived from the tool's `status`. The mapping was duplicated inline
// in each component; FRI-137 extracts it here so (a) the file-edit header
// reuses the identical visual vocabulary and (b) the node/forks vitest pool
// can unit-test the derivation without a DOM.

export type ToolStatus = "running" | "done" | "error" | "aborted";

/** `.badge` modifier class for a status: ok / error / muted / warn. */
export function badgeClass(s: string): string {
  if (s === "done") return "ok";
  if (s === "error") return "error";
  if (s === "aborted") return "muted";
  return "warn"; // running (and any unknown) → warn
}

/** Human-readable badge text: "running…" / "done" / "stopped" / passthrough. */
export function statusLabel(s: string): string {
  if (s === "running") return "running…";
  if (s === "done") return "done";
  if (s === "aborted") return "stopped";
  return s; // "error" and any unknown render verbatim
}
