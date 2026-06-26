/**
 * Friction scoring over orchestrator transcripts. Detects user moments of
 * correction, confusion, repetition, frustration, doubt, redirect, or
 * session reset — the leading indicators of trust erosion between the user
 * and the orchestrator.
 *
 * Adapted from old SlackAgents Friday. Two changes for the new system:
 *   - Source-of-truth for "which sessions belong to the orchestrator" is now
 *     the SQLite `agents` table + the `turns` table, not Slack's per-channel
 *     session JSON. Any agent of type=orchestrator (current or historical)
 *     contributes its sessions.
 *   - Transcript content is read from the SQLite `turns` table (which the
 *     JSONL mirror keeps in sync) rather than walking the JSONL files. Same
 *     content, indexed lookup.
 *
 * The Haiku-based scoring remains identical — the friction taxonomy
 * (correction / confusion / repeat / reset / frustration / doubt / redirect)
 * is general-purpose user-orchestrator interaction analysis, not specific
 * to any chat surface.
 *
 * The collect → batch → score → bucket pipeline lives in run-scanner.ts; this
 * file contributes only the friction `Taxonomy` (payload projection, default
 * LLM scorer, and the cross-session-diversity bucketing rule).
 */

import type { EvidencePointer, Signal } from "./types.js";
import { signalHash } from "./scan.js";
import { chat, extractJson } from "./llm.js";
import { dbTurnIdToLine, type OrchestratorTurn } from "./collect.js";
import {
  runScanner,
  truncate,
  clamp,
  severityFor,
  severityRank,
  type RunScannerOptions,
  type Taxonomy,
} from "./run-scanner.js";

export type FrictionCategory =
  | "correction"
  | "confusion"
  | "repeat"
  | "reset"
  | "frustration"
  | "doubt"
  | "redirect"
  | "none";

export type FrictionScanOptions = RunScannerOptions<TurnForScoring, ScoredTurn>;

export interface ScoredTurn {
  turn_id: string;
  friction_score: number;
  category: FrictionCategory;
  reason: string;
}

export type ScoreFn = (batch: TurnForScoring[], model: string) => Promise<ScoredTurn[]>;

export interface TurnForScoring {
  turn_id: string;
  user_text: string;
  prev_assistant_text: string;
}

export async function scanFriction(opts: FrictionScanOptions = {}): Promise<Signal[]> {
  return runScanner(frictionTaxonomy, opts, undefined);
}

export function bucketFrictionByCategory(scored: Array<OrchestratorTurn & ScoredTurn>): Signal[] {
  const buckets = new Map<string, Signal>();
  const ranked = [...scored].sort((a, b) => b.friction_score - a.friction_score);

  for (const t of ranked) {
    if (t.friction_score < 3) continue;
    if (t.category === "none") continue;

    const event = `friction_${t.category}`;
    const severity = severityFor(t.friction_score);
    const hash = signalHash(event, "orchestrator");
    const pointer: EvidencePointer = {
      kind: "transcript",
      path: t.filePath,
      line: dbTurnIdToLine(t.dbTurnId),
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
      const eps = existing.evidencePointers;
      if (eps.length < 5) {
        eps.push(pointer);
      } else {
        // Prefer cross-session diversity: if all existing pointers share the
        // same session and the new pointer is from a different session, swap
        // out the last one so the enricher sees evidence from multiple sessions.
        const allSameSession = eps.every((p) => p.sessionId === eps[0].sessionId);
        if (allSameSession && pointer.sessionId !== eps[0].sessionId) {
          eps[eps.length - 1] = pointer;
        }
      }
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

const SCORING_SYSTEM_PROMPT = [
  "You score user messages from an orchestrator-agent transcript for friction:",
  "moments where the user is correcting, confused, frustrated, repeating themselves,",
  "doubting the agent, redirecting work, or resetting because the agent went off track.",
  "Trust between the user and the agent is built or eroded one turn at a time —",
  "your job is to detect erosion early so the system can address it.",
  "",
  "For each user turn, output:",
  "  - friction_score: integer 0–5",
  "      0 = neutral request / no friction",
  "      1 = mild reformulation, polite hedge",
  "      2 = clear correction or 'wait, why...'",
  "      3 = repeated correction, polite frustration",
  "      4 = strong frustration, 'no, I told you...'",
  "      5 = explicit loss of trust, hostile, or session reset",
  "  - category: one of correction|confusion|repeat|reset|frustration|doubt|redirect|none",
  "      correction = user fixes a wrong assumption or output",
  "      confusion  = user is unsure why the agent did what it did",
  "      repeat     = user is re-asking the same thing because the agent missed it",
  "      reset      = user is restarting the conversation or pulling back",
  "      frustration= explicit frustration or anger",
  "      doubt      = user expresses skepticism about the agent's plan or claim",
  "      redirect   = user changes direction and signals the previous direction was wrong",
  "      none       = no friction",
  "  - reason: ≤15 words on what triggered the score",
  "",
  "Be calibrated. 'no problem' / 'no rush' / a polite 'sounds good' is friction_score 0.",
  "A direct factual correction ('no, the file is at X not Y') is friction_score 2 minimum.",
  "Be willing to score 0/none liberally — most turns are not friction.",
  "",
  "Calibration rules:",
  "  - Greetings ('Hey', 'Hi', 'Hello', 'hey there', etc.) are always friction_score 0 / category none, regardless of context.",
  "  - A single constructive correction where the agent adjusts correctly is score 1–2 max. Score 2 is the ceiling for isolated corrections in otherwise productive sessions.",
  "  - Score 3+ requires repetition (user had to say the same thing twice) or explicit frustration language.",
  "  - Normal iterative work ('try X' → agent tries → user gives feedback → agent adjusts) is score 0.",
  "",
  'Respond with a JSON object: {"turns":[{"turn_id":"...","friction_score":N,"category":"...","reason":"..."}, ...]}',
  "No prose, no markdown fences, just the JSON. Match every input turn_id exactly.",
].join("\n");

const defaultScoreFn: ScoreFn = async (batch, model) => {
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

  const parsed = extractJson<{ turns?: ScoredTurn[] }>(reply.text);
  if (!parsed || !Array.isArray(parsed.turns)) return [];

  const allowed: FrictionCategory[] = [
    "correction",
    "confusion",
    "repeat",
    "reset",
    "frustration",
    "doubt",
    "redirect",
    "none",
  ];
  return parsed.turns
    .filter((t) => t && typeof t.turn_id === "string")
    .map((t) => ({
      turn_id: t.turn_id,
      friction_score: clamp(Number(t.friction_score) || 0, 0, 5),
      category: allowed.includes(t.category) ? t.category : "none",
      reason: typeof t.reason === "string" ? t.reason : "",
    }));
};

/** The friction adapter fed to the deep `runScanner` core. */
const frictionTaxonomy: Taxonomy<TurnForScoring, ScoredTurn> = {
  name: "friction",
  modelTask: "scanFriction",
  buildPayload: (t) => ({
    turn_id: t.turnId,
    user_text: truncate(t.userText, 800),
    prev_assistant_text: truncate(t.prevAssistantText, 400),
  }),
  defaultScoreFn,
  bucket: (scored) => bucketFrictionByCategory(scored),
};
