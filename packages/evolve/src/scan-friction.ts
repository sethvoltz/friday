import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_PATH, type AgentRegistry } from "@friday/shared";
import type { EvidencePointer, Signal, SignalSeverity } from "./store.js";
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
  /** Root directory holding session subdirs (defaults to ~/.claude/projects). */
  projectsRoot?: string;
  /** ISO string lower bound — turns earlier than this are skipped. */
  since?: string;
  /** Override agents.json path (tests). */
  agentsPath?: string;
  /** Maximum user turns to evaluate per scan. Cap defends against runaway cost. Default 1000. */
  maxTurns?: number;
  /** Turns per LLM batch. Default 30. */
  batchSize?: number;
  /** Haiku model id. Default the current Haiku 4.5. */
  model?: string;
  /** Injected for tests — replaces the real LLM call. */
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

interface OrchestratorTurn {
  sessionId: string;
  filePath: string;
  lineNumber: number;
  turnId: string;
  ts: string;
  userText: string;
  prevAssistantText: string;
}

/**
 * Walk orchestrator transcripts and score every user turn for friction with
 * Haiku. Emits one signal per (category, agent="orchestrator") with `count`
 * reflecting how many turns landed in that category. Evidence pointers point
 * at the JSONL line of the highest-friction examples (capped at 3).
 *
 * Self-exclusion: only orchestrator session ids (current + former) are read.
 * Other sessions are ignored entirely so we don't score builder/helper noise.
 */
export async function scanFriction(opts: FrictionScanOptions = {}): Promise<Signal[]> {
  const projectsRoot = opts.projectsRoot ?? defaultProjectsRoot();
  if (!existsSync(projectsRoot)) return [];

  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  const maxTurns = opts.maxTurns ?? 1000;
  const batchSize = opts.batchSize ?? 30;
  const model = opts.model ?? "claude-haiku-4-5-20251001";
  const score = opts.scoreFn ?? defaultScoreFn;

  const orchestratorSessions = collectOrchestratorSessions(opts.agentsPath);
  if (orchestratorSessions.size === 0) return [];

  const turns = collectOrchestratorTurns(projectsRoot, orchestratorSessions, sinceMs, maxTurns);
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
    } catch {
      // Swallow — better to score fewer turns than to abort the scan and
      // lose every other scanner's output. The next run will retry.
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

/**
 * Group scored turns into one signal per category, with the top-friction
 * turns serving as evidence pointers (max 3 per signal).
 */
function bucketByCategory(scored: Array<OrchestratorTurn & ScoredTurn>): Signal[] {
  const buckets = new Map<string, Signal>();
  // Sort once so each category's evidence pointers are highest-friction first.
  const ranked = [...scored].sort((a, b) => b.friction_score - a.friction_score);

  for (const t of ranked) {
    if (t.friction_score < 2) continue;
    if (t.category === "none") continue;

    const event = `friction_${t.category}`;
    const severity = severityFor(t.friction_score);
    const hash = signalHash(event, "orchestrator");
    const pointer: EvidencePointer = {
      kind: "transcript",
      path: t.filePath,
      line: t.lineNumber,
      sessionId: t.sessionId,
    };

    const existing = buckets.get(hash);
    if (existing) {
      existing.count++;
      if (t.ts > existing.lastSeenAt) existing.lastSeenAt = t.ts;
      if (t.ts < existing.firstSeenAt) existing.firstSeenAt = t.ts;
      // Promote severity if a stronger turn shows up later.
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
 * Walk every orchestrator session's JSONL, return user turns paired with the
 * immediately preceding assistant text. Capped at `maxTurns` total — the cap
 * is FIFO across files (ordered by mtime ascending so older sessions get
 * scored first if we hit the ceiling on a high-volume run).
 */
function collectOrchestratorTurns(
  projectsRoot: string,
  sessionIds: Set<string>,
  sinceMs: number,
  maxTurns: number
): OrchestratorTurn[] {
  const out: OrchestratorTurn[] = [];

  // Find every JSONL whose basename (sans extension) is in sessionIds.
  const candidates: Array<{ filePath: string; sessionId: string; mtimeMs: number }> = [];
  for (const projectDir of safeReaddir(projectsRoot)) {
    const dir = join(projectsRoot, projectDir);
    if (!safeIsDir(dir)) continue;
    for (const file of safeReaddir(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.replace(/\.jsonl$/, "");
      if (!sessionIds.has(sessionId)) continue;
      const filePath = join(dir, file);
      const stat = safeStat(filePath);
      if (!stat) continue;
      if (sinceMs && stat.mtimeMs < sinceMs) continue;
      candidates.push({ filePath, sessionId, mtimeMs: stat.mtimeMs });
    }
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);

  for (const { filePath, sessionId } of candidates) {
    if (out.length >= maxTurns) break;
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const lines = raw.split("\n");
    let prevAssistantText = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      // Track the most recent assistant text so user turns get context.
      if (parsed.type === "assistant") {
        const content = parsed.message?.content;
        const txt = extractText(content);
        if (txt) prevAssistantText = txt;
        continue;
      }

      if (parsed.type !== "user") continue;
      // Skip pure tool_result echoes — they carry no human friction.
      if (isToolResultOnly(parsed.message?.content)) continue;

      const ts = parsed.timestamp ?? parsed.ts;
      const tsMs = ts ? Date.parse(ts) : 0;
      if (sinceMs && tsMs && tsMs < sinceMs) continue;

      const userText = extractText(parsed.message?.content);
      if (!userText.trim()) continue;
      // Strip auto-injected memory-context blocks — they aren't user words and
      // they balloon prompt size.
      const cleaned = stripMemoryContext(userText).trim();
      if (!cleaned) continue;

      out.push({
        sessionId,
        filePath,
        lineNumber: i + 1,
        turnId: parsed.uuid ?? `${sessionId}:${i}`,
        ts: ts ?? new Date().toISOString(),
        userText: cleaned,
        prevAssistantText,
      });
      if (out.length >= maxTurns) break;
    }
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
      if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
    }
  }
  return parts.join(" ");
}

function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return false;
  return content.every(
    (c) => c && typeof c === "object" && "type" in c && (c as { type: string }).type === "tool_result"
  );
}

function stripMemoryContext(text: string): string {
  return text.replace(/<memory-context>[\s\S]*?<\/memory-context>\s*/g, "");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function collectOrchestratorSessions(agentsPath: string = AGENTS_PATH): Set<string> {
  const out = new Set<string>();
  if (!existsSync(agentsPath)) return out;
  try {
    const registry = JSON.parse(readFileSync(agentsPath, "utf-8")) as AgentRegistry;
    const orch = registry["orchestrator"] as
      | { sessionId?: string | null; formerSessionIds?: string[] }
      | undefined;
    if (!orch) return out;
    if (orch.sessionId) out.add(orch.sessionId);
    if (Array.isArray(orch.formerSessionIds)) for (const s of orch.formerSessionIds) out.add(s);
  } catch {
    // Empty set — better to no-op than crash a scan on a malformed registry.
  }
  return out;
}

function defaultProjectsRoot(): string {
  return join(process.env.HOME ?? "", ".claude", "projects");
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeStat(path: string): { mtimeMs: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
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
  "Respond with a JSON object: {\"turns\":[{\"turn_id\":\"...\",\"friction_score\":N,\"category\":\"...\",\"reason\":\"...\"}, ...]}",
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

  // Normalize: clamp scores, fall back to 'none' for unknown categories.
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
