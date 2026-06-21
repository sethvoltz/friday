/**
 * FRI-26 Memory Dreaming — candidate-memory detector over orchestrator
 * transcripts. The constructive sibling of scan-preferences.ts: instead of
 * emitting one signal per *preference category*, it emits one signal per
 * *candidate memory* the LLM proposes writing, scored against the FIVE
 * Memory-protocol categories (user | feedback | project | reference | person).
 *
 * Why a separate scanner: dreaming auto-applies WITHOUT a later `evolve_enrich`
 * pass, so the LLM's proposed_title / proposed_content / proposed_tags must
 * reach the proposal directly. Decision B forbids widening `Signal`, so the
 * proposed-memory payload rides inside the FIRST `EvidencePointer.path` of each
 * signal (prefix "dream:payload:"); `propose.ts`'s `draftFromSignal` decodes it
 * (see decodeDreamPayload) to build the memory proposal. Evidence-note pointers
 * (recall stats + friction co-occurrence) follow the payload pointer and are
 * capped at 3.
 *
 * The promote-vs-reinforce distinction rides in the signal `key`
 * (`dream:promote:<slug>` / `dream:reinforce:<slug>`); the category is NOT in
 * the key — it is recovered from the decoded payload downstream (design D3).
 */

import { loadConfig, resolveModelForEvolveTask } from "@friday/shared";
import type { EvidencePointer, Signal, SignalSeverity } from "./types.js";
import {
  collectOrchestratorTurns,
  dbTurnIdToLine,
  type OrchestratorTurn,
} from "./scan-friction.js";
import { signalHash } from "./scan.js";
import { chat, extractJson } from "./llm.js";
import { slugify } from "./apply.js";
import type { DreamCategory } from "./dreaming-thresholds.js";

/**
 * Per-candidate LLM output. Mirrors PreferenceScoredTurn's
 * {turn_id, signal_score, category, reason} and ADDS the proposed-memory triple
 * plus an optional dedup hint.
 */
export interface DreamScoredCandidate {
  turn_id: string;
  /** Integer 0–5; >= 2 emits a signal (mirrors the preference signal_score gate). */
  signal_score: number;
  category: DreamCategory;
  reason: string;
  /** The candidate memory the LLM proposes writing. */
  proposed_title: string;
  proposed_content: string;
  proposed_tags: string[];
  /** Optional dedup hint: true if the LLM judged this already covered by an
   *  existing memory it was shown inline. Defaults false. */
  already_covered?: boolean;
}

/** Per-turn LLM payload (mirrors TurnForPreferenceScoring; adds optional evidence). */
export interface TurnForDreamScoring {
  turn_id: string;
  user_text: string;
  /** Per-turn evidence string (recall stats / co-occurring stall), rendered
   *  into the prompt's "Evidence" section. */
  evidence?: string;
}

/** Evidence assembled by /api/evolve/scan and threaded into the scan. */
export interface DreamEvidence {
  /** keyed by slugify(existing memory title) → recall stats. (Was recallStatsByTitle/lowercase.) */
  recallStatsBySlug: Map<string, { recallCount: number; lastRecalledAt: string | null }>;
  /** daemon-source signals (e.g. watchdog.stall.detected) in the same window. */
  frictionSignalsInWindow: Signal[];
  /** The CONFIGURED orchestrator agent name (cfg.orchestratorName, default "friday").
   *  Friction signals from daemon.jsonl carry the REAL agent name, not the literal "orchestrator". */
  orchestratorName?: string;
  /** Existing-corpus snapshot passed inline to the dedup prompt. */
  existingMemories?: Array<{ title: string; tags: string[] }>;
}

export type DreamScoreFn = (
  batch: TurnForDreamScoring[],
  model: string,
) => Promise<DreamScoredCandidate[]>;

export interface DreamScanOptions {
  /** ISO string lower bound (Date.parse'd to ms; mirrors scanPreferences). */
  since?: string;
  /** Maximum user turns to evaluate per scan. Default 1000. */
  maxTurns?: number;
  /** Turns per LLM batch. Default 30. */
  batchSize?: number;
  /** Model id override. Default resolves via `cfg.evolve.models.scanPreferences`. */
  model?: string;
  /** Inject for tests — replaces the real LLM call. */
  scoreFn?: DreamScoreFn;
  /** Recall/friction evidence assembled by the endpoint; optional. */
  evidence?: DreamEvidence;
}

/**
 * The proposed-memory payload carried inside the first EvidencePointer of every
 * dream signal. `propose.ts`'s `draftFromSignal` decodes it via
 * `decodeDreamPayload` to build the auto-applicable memory proposal.
 */
export interface DreamPayload {
  /** proposed_title */
  title: string;
  /** proposed_content */
  content: string;
  /** proposed_tags */
  tags: string[];
  category: Exclude<DreamCategory, "none">;
}

const DREAM_PAYLOAD_PREFIX = "dream:payload:";

/** Dream candidates are always attributed to the orchestrator, like friction
 *  and preference scoring — preferences/memories spoken to other agents are out
 *  of scope here. */
const ORCHESTRATOR_AGENT = "orchestrator";

/** Encode a DreamPayload into the first EvidencePointer of a dream signal. */
export function encodeDreamPayload(p: DreamPayload): EvidencePointer {
  return { kind: "dream", path: DREAM_PAYLOAD_PREFIX + JSON.stringify(p) };
}

/**
 * Recover the DreamPayload from a signal's evidencePointers, or null if the
 * signal is not a dream signal. `decodeDreamPayload(signal) !== null` is the
 * canonical "is this a dream signal" test downstream.
 */
export function decodeDreamPayload(signal: Signal): DreamPayload | null {
  const ptr = signal.evidencePointers.find((e) => e.path.startsWith(DREAM_PAYLOAD_PREFIX));
  if (!ptr) return null;
  try {
    return JSON.parse(ptr.path.slice(DREAM_PAYLOAD_PREFIX.length)) as DreamPayload;
  } catch {
    return null;
  }
}

export async function scanDreaming(opts: DreamScanOptions = {}): Promise<Signal[]> {
  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  const maxTurns = opts.maxTurns ?? 1000;
  const batchSize = opts.batchSize ?? 30;
  const model = opts.model ?? resolveModelForEvolveTask(loadConfig(), "scanPreferences").name;
  const score = opts.scoreFn ?? defaultScoreFn;

  const turns = await collectOrchestratorTurns(sinceMs, maxTurns);
  if (turns.length === 0) return [];

  const scored: Array<OrchestratorTurn & DreamScoredCandidate> = [];
  for (let i = 0; i < turns.length; i += batchSize) {
    const batch = turns.slice(i, i + batchSize);
    const payload: TurnForDreamScoring[] = batch.map((t) => ({
      turn_id: t.turnId,
      user_text: truncate(t.userText, 800),
      evidence: renderEvidenceForTurn(t, opts.evidence),
    }));
    let results: DreamScoredCandidate[];
    try {
      results = await score(payload, model);
    } catch (err) {
      console.error(
        `dream scoring batch ${i}-${i + batch.length - 1} failed: ${
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

  return bucketByCandidate(scored, opts.evidence);
}

/**
 * One signal per candidate memory. The hash is verb- AND category-independent
 * (`signalHash("dream:<slug>", "orchestrator")`) so it is stable across runs
 * and across the N in-window occurrences of the same candidate → propose-merge
 * dedup fires. The display `key` carries the verb (`dream:promote:<slug>` /
 * `dream:reinforce:<slug>`), decided AFTER the merge loop. The category is NOT
 * in the key — it lives in the encoded DreamPayload (design D3).
 */
export function bucketByCandidate(
  scored: Array<OrchestratorTurn & DreamScoredCandidate>,
  evidence?: DreamEvidence,
): Signal[] {
  const buckets = new Map<string, Signal>();
  // Track per-bucket recall match so the post-merge verb decision and severity
  // bump can depend on it without re-deriving from the signal.
  const recallMatch = new Map<string, boolean>();
  const ranked = [...scored].sort((a, b) => b.signal_score - a.signal_score);

  for (const t of ranked) {
    if (t.signal_score < 2) continue;
    if (t.category === "none") continue;
    if (t.already_covered === true) continue;

    const slug = slugify(t.proposed_title);
    if (!slug) continue;
    // Verb- AND category-independent → stable across runs / occurrences.
    const hash = signalHash(`dream:${slug}`, "orchestrator");

    // Recall lookup is keyed by slug — the SAME identity used for dedup/apply —
    // so the recall→severity bump (F14/AC12) is not dead in prod when the LLM's
    // title formatting differs trivially from the existing memory's title.
    const recall = evidence?.recallStatsBySlug.get(slug);
    const hasRecallMatch = recall !== undefined;

    let severity = severityFor(t.signal_score);
    // recall → severity reinforcement (design D4): an often-recalled candidate
    // bumps one severity level so it scores strictly higher downstream.
    if (recall && recall.recallCount >= 10) severity = bumpSeverity(severity);

    // First pointer = the proposed-memory payload (exempt from the 3-cap).
    const payloadPointer = encodeDreamPayload({
      title: t.proposed_title,
      content: t.proposed_content,
      tags: t.proposed_tags,
      category: t.category as Exclude<DreamCategory, "none">,
    });

    // Capped evidence-note pointers (recall stats + friction co-occurrence).
    const notes = buildEvidenceNotes(t, recall, evidence);

    const existing = buckets.get(hash);
    if (existing) {
      existing.count++;
      if (t.ts > existing.lastSeenAt) existing.lastSeenAt = t.ts;
      if (t.ts < existing.firstSeenAt) existing.firstSeenAt = t.ts;
      if (severityRank(severity) > severityRank(existing.severity)) {
        existing.severity = severity;
      }
      // Append note pointers up to the 3-cap (the payload pointer at index 0 is
      // exempt — the cap applies to the note pointers only).
      for (const note of notes) {
        if (existing.evidencePointers.length - 1 < 3) existing.evidencePointers.push(note);
      }
      if (hasRecallMatch) recallMatch.set(hash, true);
    } else {
      const pointers: EvidencePointer[] = [payloadPointer];
      for (const note of notes) {
        if (pointers.length - 1 < 3) pointers.push(note);
      }
      buckets.set(hash, {
        hash,
        source: "dream",
        // Placeholder key; overwritten after the merge loop once the verb is known.
        key: `dream:promote:${slug}`,
        severity,
        count: 1,
        firstSeenAt: t.ts,
        lastSeenAt: t.ts,
        agent: ORCHESTRATOR_AGENT,
        evidencePointers: pointers,
      });
      recallMatch.set(hash, hasRecallMatch);
    }
  }

  // Decide promote-vs-reinforce per merged signal (safe post-merge — the hash
  // does not depend on the verb). reinforce iff it recurred in-window OR the
  // candidate matches an existing memory in recall stats.
  for (const [hash, signal] of buckets) {
    const payload = decodeDreamPayload(signal);
    if (!payload) continue;
    const slug = slugify(payload.title);
    const verb = signal.count > 1 || recallMatch.get(hash) ? "reinforce" : "promote";
    signal.key = `dream:${verb}:${slug}`;
  }

  return [...buckets.values()];
}

/** Build the human-readable evidence-note pointers for a candidate. */
function buildEvidenceNotes(
  t: OrchestratorTurn & DreamScoredCandidate,
  recall: { recallCount: number; lastRecalledAt: string | null } | undefined,
  evidence?: DreamEvidence,
): EvidencePointer[] {
  const notes: EvidencePointer[] = [];
  if (recall) {
    notes.push({
      kind: "dream",
      path: `recall: existing memory '${t.proposed_title}' recallCount=${recall.recallCount}`,
      line: dbTurnIdToLine(t.dbTurnId),
      sessionId: t.sessionId,
    });
  }
  // Friction co-occurrence: cite each daemon-source stall/error signal for the
  // CONFIGURED orchestrator agent (e.g. "watchdog.stall.detected") so the diary
  // can correlate. daemon.jsonl friction signals carry the REAL agent name, so
  // we match on the configured orchestratorName (default "orchestrator"); an
  // agentless daemon signal (db.checkpoint.error, daemon.fatal) is NOT attached,
  // to avoid over-attributing unrelated daemon errors to every candidate.
  const matchAgent = evidence?.orchestratorName ?? ORCHESTRATOR_AGENT;
  for (const fs of evidence?.frictionSignalsInWindow ?? []) {
    if (fs.agent !== matchAgent) continue;
    notes.push({ kind: "dream", path: `friction: ${fs.key}` });
  }
  return notes;
}

function renderEvidenceForTurn(_t: OrchestratorTurn, evidence?: DreamEvidence): string | undefined {
  if (!evidence) return undefined;
  const lines: string[] = [];
  // Match only the CONFIGURED orchestrator agent — agentless daemon signals are
  // not attributed to the candidate (see buildEvidenceNotes for the rationale).
  const matchAgent = evidence.orchestratorName ?? ORCHESTRATOR_AGENT;
  for (const fs of evidence.frictionSignalsInWindow) {
    if (fs.agent !== matchAgent) continue;
    lines.push(`co-occurring ${fs.source} signal: ${fs.key} (severity=${fs.severity})`);
  }
  if (evidence.existingMemories && evidence.existingMemories.length > 0) {
    const titles = evidence.existingMemories.map((m) => m.title).join("; ");
    lines.push(`existing memories: ${titles}`);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function severityFor(score: number): SignalSeverity {
  if (score >= 4) return "high";
  if (score >= 3) return "medium";
  return "low";
}

function bumpSeverity(s: SignalSeverity): SignalSeverity {
  return s === "low" ? "medium" : "high";
}

function severityRank(s: SignalSeverity): number {
  return s === "high" ? 3 : s === "medium" ? 2 : 1;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

const SCORING_SYSTEM_PROMPT = [
  "You scan user messages from an orchestrator-agent transcript and propose any",
  "NEW persistent memory worth saving — durable facts about the user, their",
  "feedback, their projects, external references, and the people they mention,",
  "following the Friday Memory protocol's FIVE categories.",
  "",
  "You are shown the existing memory corpus inline (in each turn's Evidence",
  "section, under 'existing memories'). Your job is to surface memories that are",
  "NOT already covered. If a turn duplicates an existing memory, set",
  "already_covered: true and score it low.",
  "",
  "For each user turn, output:",
  "  - signal_score: integer 0–5",
  "      0 = nothing worth remembering / general question / one-off task instruction",
  "      1 = mild, transient context ('I'm tired today')",
  "      2 = a clear durable fact worth saving ('I work in Pacific time')",
  "      3 = an explicit standing fact or directive ('always deploy via friday update')",
  "      4 = a strong, reusable fact with reasoning",
  "      5 = an identity- or relationship-defining fact",
  "  - category: one of user|feedback|project|reference|person|none",
  "      user      = the user's identity, role, preferences, working style, environment",
  "      feedback  = corrections the user gave the agent that should change future behavior",
  "      project   = facts about the codebase/product/architecture the user is building",
  "      reference = pointers to external systems (Linear, Grafana, repos, dashboards)",
  "      person    = facts about a SPECIFIC named human the user mentions (not the user)",
  "      none      = nothing durable to remember",
  "  - reason: ≤20 words capturing what the turn establishes.",
  "  - proposed_title: a concise memory title. For category=person, use the shape",
  "    '<Name> — <short summary>' (e.g. 'Dana Chen — Linear admin, prefers async').",
  "  - proposed_content: the memory body (1–4 sentences, declarative, durable).",
  "  - proposed_tags: 1–4 lowercase tags. For category=person you MUST include",
  "    'person' AND 'person:<name>' (lowercase, dashes for spaces, e.g.",
  "    'person:dana-chen'), plus 1–2 topical tags. Persons are recall-suppressed",
  "    by default — these tags are how they are later surfaced deliberately.",
  "  - already_covered: true ONLY if an existing memory shown inline already",
  "    captures this fact; otherwise false.",
  "",
  "Be calibrated. A one-off task instruction ('rename this file to X') is NOT a",
  "memory — score 0/none. A standing fact ('I always use pnpm') IS. Generic small",
  "talk, gratitude, or transient mood: 0/none.",
  "",
  "Most turns are score 0/none — be liberal with that. Better to miss a borderline",
  "case than to spam proposals.",
  "",
  'Respond with a JSON object: {"turns":[{"turn_id":"...","signal_score":N,"category":"...","reason":"...","proposed_title":"...","proposed_content":"...","proposed_tags":["..."],"already_covered":false}, ...]}',
  "No prose, no markdown fences, just the JSON. Match every input turn_id exactly.",
].join("\n");

const defaultScoreFn: DreamScoreFn = async (batch, model) => {
  const userPrompt = [
    "Score the following turns and propose memories. Respond with the JSON object as specified.",
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

  const parsed = extractJson<{ turns?: DreamScoredCandidate[] }>(reply.text);
  if (!parsed || !Array.isArray(parsed.turns)) return [];

  const allowed: DreamCategory[] = ["user", "feedback", "project", "reference", "person", "none"];
  return parsed.turns
    .filter((t) => t && typeof t.turn_id === "string")
    .map((t) => ({
      turn_id: t.turn_id,
      signal_score: clamp(Number(t.signal_score) || 0, 0, 5),
      category: allowed.includes(t.category) ? t.category : "none",
      reason: typeof t.reason === "string" ? t.reason : "",
      proposed_title: typeof t.proposed_title === "string" ? t.proposed_title : "",
      proposed_content: typeof t.proposed_content === "string" ? t.proposed_content : "",
      proposed_tags: Array.isArray(t.proposed_tags)
        ? t.proposed_tags.filter((x): x is string => typeof x === "string")
        : [],
      already_covered: Boolean(t.already_covered),
    }));
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
