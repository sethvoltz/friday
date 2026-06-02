/**
 * FRI-149 — pure planner that maps promote-to-critical proposals to
 * auto-fixing Builder spawn requests.
 *
 * This is the Phase-2 sibling of `triage-spawn.ts`. Where triage spawns a
 * read-only helper that investigates and reports, this plans a Builder that
 * actually drives the fix to a review-ready, GREEN PR — and then STOPS. The
 * Builder never merges; the human reviews the PR and merges. The
 * human-approval gate moves from approve-before-spawn (ADR-022 / ADR-033) to
 * approve-before-MERGE for evolve-originated builders (see ADR-036).
 *
 * Like `triage-spawn.ts`, this module is deliberately IO-free and
 * deterministic — it imports only `./types.js` (no daemon/HTTP import, so the
 * `@friday/evolve` purity boundary holds). The daemon's `POST /api/evolve/scan`
 * handler feeds it the concatenation of both promote-to-critical surfaces
 * (`propose.promotedToCritical` and `rerankAll().promoted`); this function
 * dedupes by proposal id (first occurrence wins) so feeding the raw union is
 * safe.
 *
 * Trigger band (in order): a proposal is escalated to a Builder ONLY when it is
 *   1. `status === "critical"` (the only promote surface that reaches the hook),
 *   2. `type === "code"` (memory/prompt/config proposals are never escalated —
 *      they are not solvable with a code change), AND
 *   3. has at least one high-severity signal
 *      (`signals.some((s) => s.severity === "high")`).
 *
 * The high-severity-signal predicate — NOT blast radius "high" — is the
 * decisive criticality reading: blast radius "high" is a SCORE PENALTY in
 * `rank.ts` (it lowers score, selecting LESS-confident proposals — the wrong
 * direction for auto-fix), whereas a high-severity signal is exactly the
 * `isCritical` branch that most decisively trips criticality.
 */

import type { Proposal } from "./types.js";

export interface BuilderEscalationRequest {
  /** Builder agent name: `"builder-" + proposal.id` (FULL id — no slice). */
  name: string;
  type: "builder";
  /** First-turn instruction for the escalation Builder. */
  prompt: string;
  /** Persisted spawn reason; contains the proposal id verbatim. */
  reason: string;
}

/**
 * Plan auto-fixing Builder spawns for the proposals that just promoted to
 * critical and qualify (critical + code + at-least-one high-severity signal).
 *
 * Steps:
 *   1. Filter to `status === "critical"` AND `type === "code"` AND a
 *      high-severity signal.
 *   2. Dedupe by proposal id (first occurrence wins) — safe to feed the raw
 *      union of both promote surfaces.
 *   3. Map each survivor to a `BuilderEscalationRequest`.
 *
 * The builder name uses the FULL proposal id (same reasoning as triage-spawn:
 * proposal ids are `<slug>-<4char>`, so a prefix slice would collide across
 * siblings sharing a slug prefix).
 */
export function builderEscalationPlan(promoted: Proposal[]): BuilderEscalationRequest[] {
  const seen = new Set<string>();
  const requests: BuilderEscalationRequest[] = [];

  for (const p of promoted) {
    if (p.status !== "critical") continue;
    if (p.type !== "code") continue;
    if (!p.signals.some((s) => s.severity === "high")) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);

    const signalKey = p.signals[0] ? p.signals[0].key : "unknown";
    const reason =
      "evolve auto-escalation: proposal " +
      p.id +
      " promoted to critical (code + high-severity signal " +
      signalKey +
      ") — Builder drives a green PR; human merges";

    requests.push({
      name: "builder-" + p.id,
      type: "builder",
      reason,
      prompt: builderPrompt(p.id),
    });
  }

  return requests;
}

function builderPrompt(proposalId: string): string {
  return [
    `You are an evolve escalation Builder for proposal \`${proposalId}\`, which just promoted to critical (a code-fixable, high-severity regression). You were auto-spawned; there is no orchestrator turn behind you to lean on.`,
    "",
    "Your job for this run:",
    `1. Call \`evolve_get({ id: "${proposalId}" })\` to read the proposal, its signals, evidence pointers, and proposed change.`,
    "2. Follow the evidence pointers to understand the root cause, then implement the SMALLEST code change that fixes it in your worktree.",
    "3. Run the tests, the linters, and the type checks. Fix anything you broke.",
    "4. Stage, commit (Conventional Commits), and push your branch.",
    `5. Open a PR via \`gh\`. Reference the proposal id \`${proposalId}\` in the PR body. If a Linear ticket is linked, include \`Closes FRI-N\` on its own line in the body.`,
    "6. Verify CI is GREEN: run `gh pr checks <PR-number> --watch` and wait for every check to pass. If any check fails, fix the root cause, commit, push, and re-check.",
    `7. Once CI is green, mail the orchestrator the review-ready PR URL: \`mail_send({ to: "friday", type: "notification", body: ... })\`. Include the proposal id \`${proposalId}\`, the PR URL, and a short summary of the fix.`,
    "8. Then STOP and wait for further instructions.",
    "",
    "Hard constraint — STOP AT A GREEN PR. The human reviews and merges:",
    "- Do NOT run `gh pr merge`. Do NOT merge the PR by any means. Merging is the human approval gate — it is NOT yours to cross.",
    "- Do NOT close or delete the PR; leave it review-ready.",
    "- A stable, green, review-ready PR is the finish line. Halt there.",
  ].join("\n");
}
