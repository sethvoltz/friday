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
import type { EvidencePointer, Signal, SignalSeverity } from "./types.js";
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

export type ScoreFn = (batch: TurnForScoring[], model: string) => Promise<ScoredTurn[]>;

export interface TurnForScoring {
  turn_id: string;
  user_text: string;
  prev_assistant_text: string;
}

export interface OrchestratorTurn {
  sessionId: string;
  /** Source JSONL file (recorded on the turns row). */
  filePath: string;
  /** Synthetic id for matching back from LLM scoring output. */
  turnId: string;
  /** ISO timestamp. */
  ts: string;
  userText: string;
  prevAssistantText: string;
  /** DB row id. Phase 4.11 flipped `blocks.id` to text (UUID), so
   *  this can be a UUID for newer rows or a bigserial-shaped
   *  numeric string for legacy rows. We parse it as a number for
   *  the EvidencePointer's `line` field (falls through to omitted
   *  when NaN). */
  dbTurnId: string;
}

export function dbTurnIdToLine(id: string): number | undefined {
  const n = Number(id);
  return Number.isFinite(n) ? n : undefined;
}

export async function scanFriction(opts: FrictionScanOptions = {}): Promise<Signal[]> {
  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  const maxTurns = opts.maxTurns ?? 1000;
  const batchSize = opts.batchSize ?? 30;
  const model = opts.model ?? "claude-haiku-4-5-20251001";
  const score = opts.scoreFn ?? defaultScoreFn;

  const turns = await collectOrchestratorTurns(sinceMs, maxTurns);
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

function bucketByCategory(scored: Array<OrchestratorTurn & ScoredTurn>): Signal[] {
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
      if (existing.evidencePointers.length < 3) existing.evidencePointers.push(pointer);
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
async function collectOrchestratorSessions(): Promise<Set<string>> {
  const out = new Set<string>();
  const db = getDb();

  const orchAgents = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.type, "orchestrator"));
  if (orchAgents.length === 0) return out;

  for (const a of orchAgents) {
    if (a.sessionId) out.add(a.sessionId);
  }

  // Historic session enumeration via the `blocks` table — the legacy
  // `turns` table is retired per ADR-016. Distinct session_id values
  // for any orchestrator-named agent's blocks.
  const orchNames = orchAgents.map((a) => a.name);
  const historicSessions = await db
    .selectDistinct({ sessionId: schema.blocks.sessionId })
    .from(schema.blocks)
    .where(inArray(schema.blocks.agentName, orchNames));
  for (const t of historicSessions) {
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
export async function collectOrchestratorTurns(
  sinceMs: number,
  maxTurns: number,
): Promise<OrchestratorTurn[]> {
  const sessionIds = await collectOrchestratorSessions();
  if (sessionIds.size === 0) return [];

  // Ported to the `blocks` table per ADR-016 + ADR-023. Each block row is
  // already a single semantic unit (text / thinking / tool_use / tool_result
  // / user / mail); we no longer parse a JSONL-style `content_json` envelope
  // with `type=user|assistant`. The friction scorer wants pairs of
  // (user-typed text, immediately-preceding assistant text), so we walk
  // blocks in ts order, accumulate the latest assistant text per session,
  // and emit a turn whenever we see a user-role text/user block.
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.blocks)
    .where(inArray(schema.blocks.sessionId, [...sessionIds]));
  // Sort ts ascending so older sessions get scored first when capped.
  rows.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  const out: OrchestratorTurn[] = [];
  const prevAssistantBySession = new Map<string, string>();

  for (const r of rows) {
    const rTsMs = r.ts.getTime();
    if (sinceMs && rTsMs < sinceMs) continue;
    if (out.length >= maxTurns) break;

    // contentJson is jsonb; Drizzle returns it as the parsed object. Block
    // payloads are shaped per-kind; we only need the `text` field for the
    // text + user kinds.
    const content = r.contentJson as { text?: string };

    if (r.role === "assistant" && r.kind === "text") {
      const txt = typeof content?.text === "string" ? content.text : "";
      if (txt) prevAssistantBySession.set(r.sessionId, txt);
      continue;
    }

    // User-typed blocks (chat input, scratch seed, agent_spawn, schedule
    // task prompt). Skip mail-delivered user blocks — those aren't the
    // user's free-text friction signal.
    if (r.role !== "user" || r.kind !== "text") continue;
    if (r.source === "mail") continue;

    const userText = typeof content?.text === "string" ? content.text : "";
    if (!userText.trim()) continue;
    const cleaned = stripMemoryContext(userText).trim();
    if (!cleaned) continue;

    out.push({
      sessionId: r.sessionId,
      filePath: "",
      turnId: r.turnId,
      ts: r.ts.toISOString(),
      userText: cleaned,
      prevAssistantText: prevAssistantBySession.get(r.sessionId) ?? "",
      dbTurnId: r.id,
    });
  }

  return out;
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
