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
 */

import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@friday/shared";
import type {
  EvidencePointer,
  Signal,
  SignalSeverity,
} from "./types.js";
import { signalHash } from "./scan.js";
import { chat, extractJson } from "./llm.js";

export type FrictionCategory =
  | "correction"
  | "confusion"
  | "repeat"
  | "reset"
  | "frustration"
  | "doubt"
  | "redirect"
  | "none";

export interface FrictionScanOptions {
  /** ISO string lower bound — turns earlier than this are skipped. */
  since?: string;
  /** Maximum user turns to evaluate per scan. Default 1000. */
  maxTurns?: number;
  /** Turns per LLM batch. Default 30. */
  batchSize?: number;
  /** Haiku model id. Default the current Haiku 4.5. */
  model?: string;
  /** Inject for tests — replaces the real LLM call. */
  scoreFn?: ScoreFn;
}

export interface ScoredTurn {
  turn_id: string;
  friction_score: number;
  category: FrictionCategory;
  reason: string;
}

export type ScoreFn = (
  batch: TurnForScoring[],
  model: string,
) => Promise<ScoredTurn[]>;

export interface TurnForScoring {
  turn_id: string;
  user_text: string;
  prev_assistant_text: string;
}

interface OrchestratorTurn {
  sessionId: string;
  /** Source JSONL file (recorded on the turns row). */
  filePath: string;
  /** Synthetic id for matching back from LLM scoring output. */
  turnId: string;
  /** ISO timestamp. */
  ts: string;
  userText: string;
  prevAssistantText: string;
  /** DB row id; used as the evidence pointer line number. */
  dbTurnId: number;
}

export async function scanFriction(
  opts: FrictionScanOptions = {},
): Promise<Signal[]> {
  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  const maxTurns = opts.maxTurns ?? 1000;
  const batchSize = opts.batchSize ?? 30;
  const model = opts.model ?? "claude-haiku-4-5-20251001";
  const score = opts.scoreFn ?? defaultScoreFn;

  const turns = collectOrchestratorTurns(sinceMs, maxTurns);
  if (turns.length === 0) return [];

  const scored: Array<OrchestratorTurn & ScoredTurn> = [];
  for (let i = 0; i < turns.length; i += batchSize) {
    const batch = turns.slice(i, i + batchSize);
    const payload: TurnForScoring[] = batch.map((t) => ({
      turn_id: t.turnId,
      user_text: truncate(t.userText, 800),
      prev_assistant_text: truncate(t.prevAssistantText, 400),
    }));
    let results: ScoredTurn[];
    try {
      results = await score(payload, model);
    } catch (err) {
      // Better to score fewer turns than abort the whole pass; log loudly.
      // eslint-disable-next-line no-console
      console.error(
        `friction scoring batch ${i}-${i + batch.length - 1} failed: ${
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

function bucketByCategory(
  scored: Array<OrchestratorTurn & ScoredTurn>,
): Signal[] {
  const buckets = new Map<string, Signal>();
  const ranked = [...scored].sort(
    (a, b) => b.friction_score - a.friction_score,
  );

  for (const t of ranked) {
    if (t.friction_score < 2) continue;
    if (t.category === "none") continue;

    const event = `friction_${t.category}`;
    const severity = severityFor(t.friction_score);
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

/**
 * Resolve "which sessions belong to the orchestrator" by:
 *   1. Selecting all agents of type=orchestrator from the registry.
 *   2. Including their currently-attached sessionId, plus
 *   3. Every distinct sessionId in the `turns` table that's tagged with one
 *      of those agent names (catches historical sessions across resumes).
 */
function collectOrchestratorSessions(): Set<string> {
  const out = new Set<string>();
  const db = getDb();

  const orchAgents = db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.type, "orchestrator"))
    .all();
  if (orchAgents.length === 0) return out;

  for (const a of orchAgents) {
    if (a.sessionId) out.add(a.sessionId);
  }

  const orchNames = orchAgents.map((a) => a.name);
  const historicTurns = db
    .select({
      sessionId: schema.turns.sessionId,
      agentName: schema.turns.agentName,
    })
    .from(schema.turns)
    .where(inArray(schema.turns.agentName, orchNames))
    .all();
  for (const t of historicTurns) {
    if (t.sessionId) out.add(t.sessionId);
  }

  return out;
}

/**
 * Walk the `turns` table for orchestrator sessions, return user turns paired
 * with the immediately preceding assistant text. Skips pure tool_result
 * echoes and strips `<memory-context>` auto-injection blocks.
 *
 * Capped at `maxTurns`. Older sessions go first if we hit the cap.
 */
function collectOrchestratorTurns(
  sinceMs: number,
  maxTurns: number,
): OrchestratorTurn[] {
  const sessionIds = collectOrchestratorSessions();
  if (sessionIds.size === 0) return [];

  const db = getDb();
  const rows = db
    .select()
    .from(schema.turns)
    .where(inArray(schema.turns.sessionId, [...sessionIds]))
    .all();
  // Sort ts ascending so older sessions get scored first when capped.
  rows.sort((a, b) => a.ts - b.ts);

  const out: OrchestratorTurn[] = [];
  // Track previous assistant text per-session so a multi-session sweep
  // doesn't bleed context across orchestrator-resume boundaries.
  const prevAssistantBySession = new Map<string, string>();

  for (const r of rows) {
    if (sinceMs && r.ts < sinceMs) continue;
    if (out.length >= maxTurns) break;

    let parsed: unknown;
    try {
      parsed = JSON.parse(r.contentJson);
    } catch {
      continue;
    }
    const j = parsed as {
      type?: string;
      uuid?: string;
      message?: { content?: unknown };
    };

    if (j.type === "assistant") {
      const txt = extractText(j.message?.content);
      if (txt) prevAssistantBySession.set(r.sessionId, txt);
      continue;
    }

    if (j.type !== "user") continue;
    if (isToolResultOnly(j.message?.content)) continue;

    const userText = extractText(j.message?.content);
    if (!userText.trim()) continue;
    const cleaned = stripMemoryContext(userText).trim();
    if (!cleaned) continue;

    out.push({
      sessionId: r.sessionId,
      filePath: r.sourceFile,
      turnId: j.uuid ?? `${r.sessionId}:${r.turnIndex}`,
      ts: new Date(r.ts).toISOString(),
      userText: cleaned,
      prevAssistantText: prevAssistantBySession.get(r.sessionId) ?? "",
      dbTurnId: r.id,
    });
  }

  return out;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object" && "type" in c) {
      const obj = c as { type: string; text?: string };
      if (obj.type === "text" && typeof obj.text === "string")
        parts.push(obj.text);
    }
  }
  return parts.join(" ");
}

function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return false;
  return content.every(
    (c) =>
      c &&
      typeof c === "object" &&
      "type" in c &&
      (c as { type: string }).type === "tool_result",
  );
}

function stripMemoryContext(text: string): string {
  return text.replace(/<memory-context>[\s\S]*?<\/memory-context>\s*/g, "");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
