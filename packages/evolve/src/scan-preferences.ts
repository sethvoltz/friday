/**
 * Affirmative-preference detector over orchestrator transcripts. Complements
 * scan-friction.ts: friction catches *corrective* moments (the user pushing
 * back); this catches *declarative* moments (the user stating a preference,
 * role, directive, or external-system pointer). Both feed proposals of
 * `type: "memory"` by default, which the orchestrator approves via
 * `evolve_apply` to write through `saveEntry`.
 *
 * Why a separate scanner: friction's score 0–5 is calibrated for trust
 * erosion, and "from now on use pnpm" is a calm score-0 turn that would be
 * filtered out — but it's exactly the kind of statement that should become a
 * memory. Different signal, different prompt, different bucketing.
 */

import type { EvidencePointer, Signal, SignalSeverity } from "./types.js";
import {
  collectOrchestratorTurns,
  type OrchestratorTurn,
} from "./scan-friction.js";
import { signalHash } from "./scan.js";
import { chat, extractJson } from "./llm.js";

export type PreferenceCategory =
  | "preference_tooling"
  | "preference_workflow"
  | "preference_style"
  | "directive"
  | "role_context"
  | "external_pointer"
  | "none";

export interface PreferenceScanOptions {
  /** ISO string lower bound — turns earlier than this are skipped. */
  since?: string;
  /** Maximum user turns to evaluate per scan. Default 1000. */
  maxTurns?: number;
  /** Turns per LLM batch. Default 30. */
  batchSize?: number;
  /** Haiku model id. Default the current Haiku 4.5. */
  model?: string;
  /** Inject for tests — replaces the real LLM call. */
  scoreFn?: PreferenceScoreFn;
}

export interface PreferenceScoredTurn {
  turn_id: string;
  /** Integer 0–5; >= 2 emits a signal. */
  signal_score: number;
  category: PreferenceCategory;
  /** Short note on what the user stated. Surfaced into proposal evidence. */
  reason: string;
}

export interface TurnForPreferenceScoring {
  turn_id: string;
  user_text: string;
}

export type PreferenceScoreFn = (
  batch: TurnForPreferenceScoring[],
  model: string,
) => Promise<PreferenceScoredTurn[]>;

export async function scanPreferences(
  opts: PreferenceScanOptions = {},
): Promise<Signal[]> {
  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  const maxTurns = opts.maxTurns ?? 1000;
  const batchSize = opts.batchSize ?? 30;
  const model = opts.model ?? "claude-haiku-4-5-20251001";
  const score = opts.scoreFn ?? defaultScoreFn;

  const turns = collectOrchestratorTurns(sinceMs, maxTurns);
  if (turns.length === 0) return [];

  const scored: Array<OrchestratorTurn & PreferenceScoredTurn> = [];
  for (let i = 0; i < turns.length; i += batchSize) {
    const batch = turns.slice(i, i + batchSize);
    const payload: TurnForPreferenceScoring[] = batch.map((t) => ({
      turn_id: t.turnId,
      user_text: truncate(t.userText, 800),
    }));
    let results: PreferenceScoredTurn[];
    try {
      results = await score(payload, model);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `preference scoring batch ${i}-${i + batch.length - 1} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    const byId = new Map(results.map((r) => [r.turn_id, r]));
    for (const turn of batch) {
      const r = byId.get(turn.turnId);
      if (!r) continue;
      scored.push({ ...turn, ...r });
    }
  }

  return bucketByCategory(scored);
}

export function bucketByCategory(
  scored: Array<OrchestratorTurn & PreferenceScoredTurn>,
): Signal[] {
  const buckets = new Map<string, Signal>();
  const ranked = [...scored].sort((a, b) => b.signal_score - a.signal_score);

  for (const t of ranked) {
    if (t.signal_score < 2) continue;
    if (t.category === "none") continue;

    const event = t.category;
    const severity = severityFor(t.signal_score);
    // Always attribute to orchestrator — the surface is the same as friction
    // scoring, and preferences spoken to other agents are out of scope here.
    const hash = signalHash(event, "orchestrator");
    const pointer: EvidencePointer = {
      kind: "transcript",
      path: t.filePath,
      line: t.dbTurnId,
      sessionId: t.sessionId,
    };

    const existing = buckets.get(hash);
    if (existing) {
      existing.count++;
      if (t.ts > existing.lastSeenAt) existing.lastSeenAt = t.ts;
      if (t.ts < existing.firstSeenAt) existing.firstSeenAt = t.ts;
      if (severityRank(severity) > severityRank(existing.severity)) {
        existing.severity = severity;
      }
      if (existing.evidencePointers.length < 3)
        existing.evidencePointers.push(pointer);
    } else {
      buckets.set(hash, {
        hash,
        source: "transcript",
        key: event,
        severity,
        count: 1,
        firstSeenAt: t.ts,
        lastSeenAt: t.ts,
        agent: "orchestrator",
        evidencePointers: [pointer],
      });
    }
  }

  return [...buckets.values()];
}

function severityFor(score: number): SignalSeverity {
  if (score >= 4) return "high";
  if (score >= 3) return "medium";
  return "low";
}

function severityRank(s: SignalSeverity): number {
  return s === "high" ? 3 : s === "medium" ? 2 : 1;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

const SCORING_SYSTEM_PROMPT = [
  "You scan user messages from an orchestrator-agent transcript for AFFIRMATIVE",
  "preference statements — things the user said that should become persistent",
  "memories the orchestrator can rely on in future sessions.",
  "",
  "This is the constructive complement to friction scoring. Frustration and",
  "correction are out of scope here (a separate scorer handles those). You are",
  "looking for calm, declarative moments where the user told the agent who they",
  "are, how they work, what they prefer, what to remember, or where to look.",
  "",
  "For each user turn, output:",
  "  - signal_score: integer 0–5",
  "      0 = no actionable preference / general question / task instruction",
  "      1 = mild lean ('I usually...', 'I tend to...')",
  "      2 = clear preference or pointer ('I prefer X', 'we track bugs in Y')",
  "      3 = explicit directive ('from now on...', 'remember that...')",
  "      4 = strong rule with reason ('always X because Y')",
  "      5 = identity-defining statement ('I'm a senior X', 'I'm new to Y')",
  "  - category: one of preference_tooling|preference_workflow|preference_style|directive|role_context|external_pointer|none",
  "      preference_tooling  = tools, CLIs, frameworks, libraries the user prefers",
  "      preference_workflow = how they like to work (PR style, review cadence, etc.)",
  "      preference_style    = how they want the agent to communicate (terse, no summaries)",
  "      directive           = explicit 'remember/save/from now on' instructions",
  "      role_context        = the user's role, expertise, project knowledge level",
  "      external_pointer    = a reference to an external system (Linear, Grafana, repo)",
  "      none                = no durable preference signal",
  "  - reason: ≤20 words capturing what the user stated, in their own words if short.",
  "",
  "Be calibrated. A one-off task instruction ('rename this file to X') is NOT a preference — it's just the work. Score 0/none.",
  "A standing rule ('always rename files to lowercase') IS a preference. Score 3+.",
  "Generic small talk, gratitude, or transient context: 0/none.",
  "",
  "Most turns are score 0/none — be liberal with that. Better to miss a borderline case than to spam proposals.",
  "",
  'Respond with a JSON object: {"turns":[{"turn_id":"...","signal_score":N,"category":"...","reason":"..."}, ...]}',
  "No prose, no markdown fences, just the JSON. Match every input turn_id exactly.",
].join("\n");

const defaultScoreFn: PreferenceScoreFn = async (batch, model) => {
  const userPrompt = [
    "Score the following turns. Respond with the JSON object as specified.",
    "",
    "Turns:",
    JSON.stringify(batch, null, 2),
  ].join("\n");

  const reply = await chat({
    prompt: userPrompt,
    systemPrompt: SCORING_SYSTEM_PROMPT,
    model,
    timeoutMs: 90_000,
  });

  const parsed = extractJson<{ turns?: PreferenceScoredTurn[] }>(reply.text);
  if (!parsed || !Array.isArray(parsed.turns)) return [];

  const allowed: PreferenceCategory[] = [
    "preference_tooling",
    "preference_workflow",
    "preference_style",
    "directive",
    "role_context",
    "external_pointer",
    "none",
  ];
  return parsed.turns
    .filter((t) => t && typeof t.turn_id === "string")
    .map((t) => ({
      turn_id: t.turn_id,
      signal_score: clamp(Number(t.signal_score) || 0, 0, 5),
      category: allowed.includes(t.category) ? t.category : "none",
      reason: typeof t.reason === "string" ? t.reason : "",
    }));
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
