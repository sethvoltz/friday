import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  DAEMON_LOG_PATH,
  USAGE_LOG_PATH,
  FEEDBACK_LOG_PATH,
  AGENTS_PATH,
  type AgentRegistry,
} from "@friday/shared";
import type { EvidencePointer, Signal, SignalSeverity } from "./store.js";

export interface ScanOptions {
  /** Path to the daemon JSONL log. Defaults to DAEMON_LOG_PATH. */
  daemonLogPath?: string;
  /** Window: only consider events with `ts` >= this ISO string. */
  since?: string;
  /** Current time (for testing); defaults to new Date(). */
  now?: Date;
}

/**
 * High-severity event names from `services/friday/src/log.ts` callers. These are
 * the patterns we surface as actionable signals in phase 1.
 *
 * Severity assignment (subjective, tunable):
 *   high   = crash / fatal / unhandled — the system is failing to do its job.
 *   medium = stall / loop error / poller error — degraded but recoverable.
 *   low    = config/parse errors caught at boundaries — usually one-off.
 */
const EVENT_SEVERITY: Record<string, SignalSeverity> = {
  // High
  agent_health_crashed: "high",
  agent_loop_error: "high",
  agent_loop_query_error: "high",
  agent_turn_failed: "high",
  agent_error: "high",
  unhandled_rejection: "high",
  startup_error: "high",
  scheduled_run_failed: "high",
  scheduled_turn_failed: "high",
  // Medium
  agent_health_stalled: "medium",
  mail_poller_error: "medium",
  mail_poller_turn_error: "medium",
  scheduler_check_failed: "medium",
  scheduler_restore_failed: "medium",
  scheduler_restore_agent_failed: "medium",
  event_server_error: "medium",
  slack_app_error: "medium",
  // Low
  scheduler_invalid_runAt: "low",
  scheduler_invalid_nextRunAt: "low",
  scheduler_cron_parse_failed: "low",
  scheduler_drain_error: "low",
  agent_health_notify_failed: "low",
  slack_preflight_error: "low",
};

/**
 * Self-exclusion: signals from `scheduled-meta-*` agents are filtered out so
 * the meta-agent never proposes improvements about its own activity. Without
 * this, every meta-run that errors becomes input to the next meta-run — a
 * pinning anti-pattern where "the meta-agent ran" gets surfaced as something
 * to fix.
 */
const META_AGENT_PREFIX = "scheduled-meta-";

interface DaemonLogLine {
  ts?: string;
  level?: string;
  event?: string;
  agent?: string;
  [key: string]: unknown;
}

/**
 * Walk daemon.jsonl and emit one Signal per (event, agent) pair, with `count`
 * reflecting how many times the pattern fired in the window. Self-meta events
 * are excluded.
 */
export function scanDaemonLog(opts: ScanOptions = {}): Signal[] {
  const path = opts.daemonLogPath ?? DAEMON_LOG_PATH;
  if (!existsSync(path)) return [];

  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  const buckets = new Map<string, Signal>();

  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    let parsed: DaemonLogLine;
    try {
      parsed = JSON.parse(line) as DaemonLogLine;
    } catch {
      continue; // Skip malformed lines — never let one bad row kill the scan.
    }

    const event = parsed.event;
    if (!event) continue;
    const severity = EVENT_SEVERITY[event];
    if (!severity) continue; // Phase 1: only surface known interesting events.

    const ts = parsed.ts;
    if (!ts) continue;
    if (sinceMs && Date.parse(ts) < sinceMs) continue;

    const agent = typeof parsed.agent === "string" ? parsed.agent : undefined;
    if (agent && agent.startsWith(META_AGENT_PREFIX)) continue;

    const hash = signalHash(event, agent);
    const pointer: EvidencePointer = {
      kind: "daemon",
      path,
      // Line numbers are 1-indexed in editor parlance.
      line: i + 1,
    };

    const existing = buckets.get(hash);
    if (existing) {
      existing.count++;
      existing.lastSeenAt = ts;
      // Cap evidence pointer list — three is enough to investigate.
      if (existing.evidencePointers.length < 3) {
        existing.evidencePointers.push(pointer);
      }
    } else {
      buckets.set(hash, {
        hash,
        source: "daemon",
        key: event,
        severity,
        count: 1,
        firstSeenAt: ts,
        lastSeenAt: ts,
        agent,
        evidencePointers: [pointer],
      });
    }
  }

  return [...buckets.values()];
}

/**
 * Stable signal identity: same event + same agent → same bucket. Hash is
 * short (8 hex chars) so it's readable in proposal frontmatter.
 */
export function signalHash(event: string, agent?: string): string {
  const key = `${event}::${agent ?? ""}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 8);
}

/**
 * Convenience: ISO string for `windowHours` ago.
 */
export function sinceHoursAgo(windowHours: number, now: Date = new Date()): string {
  return new Date(now.getTime() - windowHours * 3_600_000).toISOString();
}

// ── Feedback (Slack edits/deletes) ───────────────────────────────────────────

interface FeedbackLine {
  ts?: string;
  kind?: "edited" | "deleted";
  channelId?: string;
  messageTs?: string;
  previousText?: string;
  newText?: string;
  agent?: string;
  sessionId?: string;
}

export interface FeedbackScanOptions {
  feedbackLogPath?: string;
  since?: string;
}

/**
 * Scan ~/.friday/evolve/feedback.jsonl for edited/deleted Slack messages.
 *
 * Phase 4 surfaces three flavors:
 *   - `slack_edited_processed`  — user edited a message we'd already responded to
 *     (signal that the response was wrong / wasn't what they meant)
 *   - `slack_deleted_processed` — user deleted a message we'd already responded to
 *     (signal that the interaction was unwanted)
 *   - `slack_retry_burst`       — multiple edits to the same message in quick
 *     succession (fingers-crossed pattern: user keeps re-asking)
 *
 * All three bucket per (kind, channel) so we don't drown in per-message noise.
 */
export function scanFeedback(opts: FeedbackScanOptions = {}): Signal[] {
  const path = opts.feedbackLogPath ?? FEEDBACK_LOG_PATH;
  if (!existsSync(path)) return [];

  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  const buckets = new Map<string, Signal>();
  const editsByMessage = new Map<string, number>();

  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    let parsed: FeedbackLine;
    try {
      parsed = JSON.parse(line) as FeedbackLine;
    } catch {
      continue;
    }

    const ts = parsed.ts;
    const kind = parsed.kind;
    const channel = parsed.channelId;
    if (!ts || !kind || !channel) continue;
    if (sinceMs && Date.parse(ts) < sinceMs) continue;

    const agent = parsed.agent;
    if (agent && agent.startsWith(META_AGENT_PREFIX)) continue;

    const messageKey = `${channel}::${parsed.messageTs ?? ""}`;
    const editCount = (editsByMessage.get(messageKey) ?? 0) + (kind === "edited" ? 1 : 0);
    editsByMessage.set(messageKey, editCount);

    const event = kind === "edited" ? "slack_edited_processed" : "slack_deleted_processed";
    bucketAppend(buckets, event, "feedback", "low", path, i + 1, ts, agent);

    if (editCount >= 3) {
      // Three edits to the same message in window = burst. Promote severity.
      bucketAppend(buckets, "slack_retry_burst", "feedback", "medium", path, i + 1, ts, agent);
    }
  }

  return [...buckets.values()];
}

// ── Usage log (token spike detection) ────────────────────────────────────────

interface UsageLine {
  ts?: string;
  sessionId?: string;
  agent?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface UsageScanOptions {
  usageLogPath?: string;
  since?: string;
  /** Multiple of the per-agent median above which a single turn is flagged. Default 4×. */
  spikeMultiplier?: number;
  /** Override agents.json path — used by tests to isolate from the real registry. */
  agentsPath?: string;
}

/**
 * Scan ~/.friday/usage.jsonl for unusually large token usage on a single turn.
 *
 * Phase 4 emits a `usage_token_spike` signal per agent that produced ≥1 turn
 * exceeding `spikeMultiplier × median(turn-tokens)` for that agent in the
 * window. Median is the minimum-information baseline that still excludes
 * skewed-by-spike means.
 *
 * Self-exclusion: meta-agent sessions are filtered using agents.json so the
 * meta-agent's own token usage never becomes input to the next meta-run.
 */
export function scanUsageLog(opts: UsageScanOptions = {}): Signal[] {
  const path = opts.usageLogPath ?? USAGE_LOG_PATH;
  if (!existsSync(path)) return [];

  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  const multiplier = opts.spikeMultiplier ?? 4;

  const metaSessions = collectMetaSessions(opts.agentsPath);
  const perAgent = new Map<string, { tokens: number; ts: string; line: number }[]>();

  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    let parsed: UsageLine;
    try {
      parsed = JSON.parse(line) as UsageLine;
    } catch {
      continue;
    }

    const ts = parsed.ts;
    if (!ts) continue;
    if (sinceMs && Date.parse(ts) < sinceMs) continue;

    const agent = parsed.agent;
    if (!agent) continue;
    if (agent.startsWith(META_AGENT_PREFIX)) continue;
    if (parsed.sessionId && metaSessions.has(parsed.sessionId)) continue;

    const tokens =
      (parsed.inputTokens ?? 0) +
      (parsed.outputTokens ?? 0) +
      (parsed.cacheReadTokens ?? 0) +
      (parsed.cacheCreationTokens ?? 0);
    if (tokens <= 0) continue;

    const arr = perAgent.get(agent) ?? [];
    arr.push({ tokens, ts, line: i + 1 });
    perAgent.set(agent, arr);
  }

  const buckets = new Map<string, Signal>();
  for (const [agent, turns] of perAgent) {
    if (turns.length < 5) continue; // Need a few turns before "spike" is meaningful.
    const sorted = [...turns].map((t) => t.tokens).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const threshold = median * multiplier;
    const spikes = turns.filter((t) => t.tokens >= threshold);
    if (spikes.length === 0) continue;

    for (const spike of spikes) {
      bucketAppend(
        buckets,
        "usage_token_spike",
        "usage",
        "medium",
        path,
        spike.line,
        spike.ts,
        agent
      );
    }
  }

  return [...buckets.values()];
}

// ── Transcripts (retry detection) ────────────────────────────────────────────

interface TranscriptScanOptions {
  /** Root directory holding session subdirs (defaults to ~/.claude/projects). */
  projectsRoot?: string;
  since?: string;
  /** Cosine similarity threshold above which two consecutive user messages count as a retry. Default 0.6. */
  similarityThreshold?: number;
  /** Maximum gap (seconds) between user messages for retry consideration. Default 300. */
  windowSeconds?: number;
  /** Override agents.json path — used by tests to isolate from the real registry. */
  agentsPath?: string;
}

interface TranscriptUserTurn {
  ts: number;
  text: string;
}

/**
 * Scan transcripts under ~/.claude/projects for "retry" patterns: consecutive
 * user messages within `windowSeconds` whose token-overlap (cosine over a
 * bag-of-words) exceeds `similarityThreshold`. Each detected retry adds to a
 * single `transcript_user_retry` signal, agent-scoped by session id.
 *
 * Self-exclusion: any transcript whose owning session belongs to a
 * `scheduled-meta-*` agent is skipped.
 */
export function scanTranscripts(opts: TranscriptScanOptions = {}): Signal[] {
  const projectsRoot = opts.projectsRoot ?? defaultProjectsRoot();
  if (!existsSync(projectsRoot)) return [];

  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  const threshold = opts.similarityThreshold ?? 0.6;
  const windowMs = (opts.windowSeconds ?? 300) * 1000;

  const metaSessions = collectMetaSessions(opts.agentsPath);
  const buckets = new Map<string, Signal>();

  const projectDirs = safeReaddir(projectsRoot);
  for (const projectDir of projectDirs) {
    const dirPath = join(projectsRoot, projectDir);
    if (!safeIsDir(dirPath)) continue;

    const files = safeReaddir(dirPath).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const filePath = join(dirPath, file);
      const sessionId = file.replace(/\.jsonl$/, "");
      if (metaSessions.has(sessionId)) continue;

      // Cheap mtime gate before slurping the file.
      const stat = safeStat(filePath);
      if (!stat) continue;
      if (sinceMs && stat.mtimeMs < sinceMs) continue;

      const turns = collectUserTurns(filePath, sinceMs);
      const retries = countRetries(turns, threshold, windowMs);
      if (retries === 0) continue;

      for (let r = 0; r < retries; r++) {
        bucketAppend(
          buckets,
          "transcript_user_retry",
          "transcript",
          "medium",
          filePath,
          undefined,
          new Date(stat.mtimeMs).toISOString(),
          undefined,
          sessionId
        );
      }
    }
  }

  return [...buckets.values()];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function bucketAppend(
  buckets: Map<string, Signal>,
  event: string,
  source: Signal["source"],
  severity: SignalSeverity,
  path: string,
  line: number | undefined,
  ts: string,
  agent: string | undefined,
  sessionId?: string
): void {
  const hash = signalHash(event, agent);
  const pointer: EvidencePointer = { kind: source, path };
  if (typeof line === "number") pointer.line = line;
  if (sessionId) pointer.sessionId = sessionId;

  const existing = buckets.get(hash);
  if (existing) {
    existing.count++;
    existing.lastSeenAt = ts;
    if (existing.evidencePointers.length < 3) existing.evidencePointers.push(pointer);
    return;
  }

  buckets.set(hash, {
    hash,
    source,
    key: event,
    severity,
    count: 1,
    firstSeenAt: ts,
    lastSeenAt: ts,
    agent,
    evidencePointers: [pointer],
  });
}

/**
 * Resolve the set of session ids belonging to scheduled-meta-* agents. Used to
 * filter out meta-agent activity from usage and transcript scans (one of the
 * defenses against the self-feedback loop).
 *
 * Failures (missing file, parse error) intentionally return an empty set:
 * better to over-include than to crash a scan because of a malformed registry.
 */
function collectMetaSessions(agentsPath: string = AGENTS_PATH): Set<string> {
  const out = new Set<string>();
  if (!existsSync(agentsPath)) return out;
  try {
    const registry = JSON.parse(readFileSync(agentsPath, "utf-8")) as AgentRegistry;
    for (const [name, entry] of Object.entries(registry)) {
      if (!name.startsWith(META_AGENT_PREFIX)) continue;
      const sid = (entry as { sessionId?: string | null }).sessionId;
      if (sid) out.add(sid);
      const former = (entry as { formerSessionIds?: string[] }).formerSessionIds;
      if (Array.isArray(former)) for (const s of former) out.add(s);
    }
  } catch {
    // Empty set — see comment above.
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

/**
 * Pull user-message text out of a Claude Code transcript JSONL. Each line is
 * a typed event; user turns appear as `{type:"user", message:{role:"user", content:[...]}}`
 * with content either a string or an array of `{type:"text", text:"..."}` parts.
 *
 * `sinceMs > 0` filters by the `timestamp` field on each line (when present).
 */
function collectUserTurns(filePath: string, sinceMs: number): TranscriptUserTurn[] {
  const out: TranscriptUserTurn[] = [];
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== "user") continue;
    const message = parsed.message;
    if (!message || message.role !== "user") continue;

    const tsString = parsed.timestamp ?? parsed.ts;
    const ts = tsString ? Date.parse(tsString) : 0;
    if (sinceMs && ts && ts < sinceMs) continue;

    const text = extractText(message.content);
    if (!text) continue;
    out.push({ ts, text });
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

function countRetries(turns: TranscriptUserTurn[], threshold: number, windowMs: number): number {
  let retries = 0;
  for (let i = 1; i < turns.length; i++) {
    const a = turns[i - 1];
    const b = turns[i];
    if (b.ts && a.ts && b.ts - a.ts > windowMs) continue;
    if (cosine(tokenize(a.text), tokenize(b.text)) >= threshold) retries++;
  }
  return retries;
}

function tokenize(s: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const tok of s.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    map.set(tok, (map.get(tok) ?? 0) + 1);
  }
  return map;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [, v] of a) normA += v * v;
  for (const [, v] of b) normB += v * v;
  for (const [k, v] of a) {
    const bv = b.get(k);
    if (bv) dot += v * bv;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
