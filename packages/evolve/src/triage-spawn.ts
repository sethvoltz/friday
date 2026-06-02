/**
 * FRI-40 Phase 1 — pure planner that maps promote-to-critical proposals to
 * read-only triage-helper spawn requests.
 *
 * This module is deliberately IO-free and deterministic: the daemon's
 * `POST /api/evolve/scan` handler feeds it the concatenation of both
 * promote-to-critical surfaces (`propose.promotedToCritical` and
 * `rerankAll().promoted`), and this function dedupes by proposal id so
 * feeding the raw concatenation is safe. Each surviving proposal becomes one
 * spawn request for a `helper`-type agent whose job is read-only root-cause
 * triage — it investigates and mails the orchestrator, but mutates nothing.
 *
 * Phase 2 (auto-spawning Builders to actually fix the issue) is out of scope —
 * Builders stay behind the orchestrator's user-approval gate (Constitution §3).
 */

import type { Proposal } from "./types.js";

export interface TriageSpawnRequest {
  /** Helper agent name: `"triage-" + proposal.id` (FULL id — no slice). */
  name: string;
  type: "helper";
  /** First-turn instruction for the triage helper. Read-only mandate. */
  prompt: string;
  /** Persisted spawn reason; contains the proposal id verbatim. */
  reason: string;
}

/**
 * Plan triage-helper spawns for the proposals that just promoted to critical.
 *
 * Steps:
 *   1. Filter to `status === "critical"`.
 *   2. Dedupe by proposal id (first occurrence wins) — safe to feed the raw
 *      union of both promote surfaces.
 *   3. Map each survivor to a `TriageSpawnRequest`.
 *
 * The helper name uses the FULL proposal id. Proposal ids are
 * `<slug>-<4char>` (see `store.generateId`); a 12-char prefix would collide
 * across proposals that share a slug prefix, so the whole id is used.
 */
export function triageSpawnPlan(promoted: Proposal[]): TriageSpawnRequest[] {
  const seen = new Set<string>();
  const requests: TriageSpawnRequest[] = [];

  for (const p of promoted) {
    if (p.status !== "critical") continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);

    const signalKey = p.signals[0] ? p.signals[0].key : "unknown";
    const reason =
      "evolve auto-triage: proposal " + p.id + " promoted to critical (signal " + signalKey + ")";

    requests.push({
      name: "triage-" + p.id,
      type: "helper",
      reason,
      prompt: triagePrompt(p.id),
    });
  }

  return requests;
}

function triagePrompt(proposalId: string): string {
  return [
    `You are a read-only evolve triage helper for proposal \`${proposalId}\`, which just promoted to critical.`,
    "",
    "Your job for this run:",
    `1. Call \`evolve_get({ id: "${proposalId}" })\` to read the proposal, its signals, and its evidence pointers.`,
    "2. Follow the evidence pointers — investigate the relevant daemon logs, usage rows, and session transcripts they reference to understand WHY this signal is firing.",
    '3. Mail the orchestrator a concise root-cause summary: `mail_send({ to: "friday", type: "notification", body: ... })`. Include the proposal id, the most likely root cause, and the evidence you relied on.',
    "",
    "Hard constraint — this is READ-ONLY triage. Mutate NOTHING:",
    "- Do NOT apply or dismiss this (or any) proposal.",
    "- Do NOT edit, create, or delete any files.",
    "- Do NOT spawn builders or change system state.",
    "Investigate and report. Deciding what to DO about it is the orchestrator's call.",
  ].join("\n");
}
