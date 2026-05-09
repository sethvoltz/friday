/**
 * Walk the daemon JSONL log + SQLite usage rows + Claude session JSONL
 * transcripts and emit Signal[] for the propose/rank pipeline.
 *
 * Adapted from old SlackAgents Friday. Key differences:
 *   - Event severity map covers the new daemon's dotted event names
 *     (worker.fork, watchdog.stall.detected, etc.), not the old underscored
 *     vocabulary.
 *   - Meta-agent self-exclusion uses agent-name prefix matching only.
 *     Slack-era session-id sets via agents.json are gone.
 *   - `scanFeedback` (old Slack edit/delete log) is dropped — no Slack.
 *   - `scan-friction` (old per-channel session friction grading) is also
 *     dropped — Slack-specific and not portable to the dashboard yet.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  DAEMON_LOG_PATH,
  USAGE_LOG_PATH,
} from "@friday/shared";
import { getAllUsageEntries } from "@friday/shared/services";
import type {
  EvidencePointer,
  Signal,
  SignalSeverity,
} from "./types.js";

export interface ScanOptions {
  /** Path to the daemon JSONL log. Defaults to DAEMON_LOG_PATH. */
  daemonLogPath?: string;
  /** Window: only consider events with `ts` >= this ISO string. */
  since?: string;
  /** Current time (for testing); defaults to new Date(). */
  now?: Date;
}

/**
 * Severity assignment for new-daemon events. Tunable; non-listed events are
 * skipped (Phase 1 surfaces only known-interesting events).
 *
 *   high   = the system is failing to do its job (DB failure, daemon crash).
 *   medium = degraded but recoverable (stall, worker crash, dispatch error).
 *   low    = bounded boundary errors (one-off parse / IO).
 */
const EVENT_SEVERITY: Record<string, SignalSeverity> = {
  // High
  "daemon.fatal": "high",
  "db.checkpoint.error": "high",
  "db.close.error": "high",
  "watchdog.stall.detected": "high",
  "watchdog.refork.error": "high",
  "schedule.spawn-error": "high",
  "workspace.create.fail": "high",
  // Medium
  "watchdog.refork": "medium",
  "worker.onexit.error": "medium",
  "agent.recovery.dispatch-error": "medium",
  "mail.bridge.dispatch-error": "medium",
  "linear.reconcile.error": "medium",
  "schedule.last-run.write-error": "medium",
  "jsonl-mirror.drain.error": "medium",
  // Low
  "jsonl-mirror.open.fail": "low",
  "usage.insert.error": "low",
  "memory.recall.error": "low",
  "workspace.destroy.fail": "low",
};

const META_AGENT_PREFIX = "scheduled-meta-";

interface DaemonLogLine {
  ts?: string;
  level?: string;
  event?: string;
  agent?: string;
  [key: string]: unknown;
}

/**
 * Walk daemon.jsonl and emit one Signal per (event, agent) pair.
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
      continue;
    }

    const event = parsed.event;
    if (!event) continue;
    const severity = EVENT_SEVERITY[event];
    if (!severity) continue;

    const ts = parsed.ts;
    if (!ts) continue;
    if (sinceMs && Date.parse(ts) < sinceMs) continue;

    const agent = typeof parsed.agent === "string" ? parsed.agent : undefined;
    if (agent && agent.startsWith(META_AGENT_PREFIX)) continue;

    const hash = signalHash(event, agent);
    const pointer: EvidencePointer = {
      kind: "daemon",
      path,
      line: i + 1,
    };

    const existing = buckets.get(hash);
    if (existing) {
      existing.count++;
      existing.lastSeenAt = ts;
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
 * short (8 hex) so it's readable in proposal frontmatter.
 */
export function signalHash(event: string, agent?: string): string {
  const key = `${event}::${agent ?? ""}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 8);
}

export function sinceHoursAgo(
  windowHours: number,
  now: Date = new Date(),
): string {
  return new Date(now.getTime() - windowHours * 3_600_000).toISOString();
}

// ── Usage spike detection (DB-backed) ────────────────────────────────────────

export interface UsageScanOptions {
  since?: string;
  /** Multiple of the per-agent median above which a single turn is flagged. Default 4×. */
  spikeMultiplier?: number;
}

/**
 * Read SQLite usage rows; flag agents whose individual turn token usage
 * exceeded `spikeMultiplier × median(turn-tokens)` for that agent in the
 * window.
 */
export function scanUsage(opts: UsageScanOptions = {}): Signal[] {
  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  const multiplier = opts.spikeMultiplier ?? 4;

  const perAgent = new Map<
    string,
    Array<{ tokens: number; ts: string; pointer: EvidencePointer }>
  >();

  for (const row of getAllUsageEntries()) {
    const agent = row.agentName;
    if (!agent) continue;
    if (agent.startsWith(META_AGENT_PREFIX)) continue;
    if (sinceMs && Date.parse(row.timestamp) < sinceMs) continue;
    const tokens =
      (row.inputTokens ?? 0) +
      (row.outputTokens ?? 0) +
      (row.cacheReadTokens ?? 0) +
      (row.cacheCreationTokens ?? 0);
    if (tokens <= 0) continue;
    const arr = perAgent.get(agent) ?? [];
    arr.push({
      tokens,
      ts: row.timestamp,
      pointer: { kind: "usage", path: USAGE_LOG_PATH, line: 0 },
    });
    perAgent.set(agent, arr);
  }

  const buckets = new Map<string, Signal>();
  for (const [agent, turns] of perAgent) {
    if (turns.length < 5) continue;
    const sorted = [...turns].map((t) => t.tokens).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const threshold = median * multiplier;
    const spikes = turns.filter((t) => t.tokens >= threshold);
    if (spikes.length === 0) continue;

    for (const spike of spikes) {
      bucketAppendWithPointer(
        buckets,
        "usage_token_spike",
        "usage",
        "medium",
        spike.pointer,
        spike.ts,
        agent,
      );
    }
  }

  return [...buckets.values()];
}

// ── Transcripts (retry detection) ────────────────────────────────────────────

interface TranscriptScanOptions {
  /** Root directory holding session subdirs. Defaults to ~/.claude/projects. */
  projectsRoot?: string;
  since?: string;
  /** Cosine similarity threshold above which two consecutive user messages count as a retry. Default 0.6. */
  similarityThreshold?: number;
  /** Maximum gap (seconds) between user messages for retry consideration. Default 300. */
  windowSeconds?: number;
}

interface TranscriptUserTurn {
  ts: number;
  text: string;
}

export function scanTranscripts(opts: TranscriptScanOptions = {}): Signal[] {
  const projectsRoot = opts.projectsRoot ?? defaultProjectsRoot();
  if (!existsSync(projectsRoot)) return [];

  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  const threshold = opts.similarityThreshold ?? 0.6;
  const windowMs = (opts.windowSeconds ?? 300) * 1000;

  const buckets = new Map<string, Signal>();

  const projectDirs = safeReaddir(projectsRoot);
  for (const projectDir of projectDirs) {
    const dirPath = join(projectsRoot, projectDir);
    if (!safeIsDir(dirPath)) continue;

    const files = safeReaddir(dirPath).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const filePath = join(dirPath, file);
      const sessionId = file.replace(/\.jsonl$/, "");

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
          sessionId,
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
  sessionId?: string,
): void {
  const hash = signalHash(event, agent);
  const pointer: EvidencePointer = { kind: source, path };
  if (typeof line === "number") pointer.line = line;
  if (sessionId) pointer.sessionId = sessionId;

  const existing = buckets.get(hash);
  if (existing) {
    existing.count++;
    existing.lastSeenAt = ts;
    if (existing.evidencePointers.length < 3)
      existing.evidencePointers.push(pointer);
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

function bucketAppendWithPointer(
  buckets: Map<string, Signal>,
  event: string,
  source: Signal["source"],
  severity: SignalSeverity,
  pointer: EvidencePointer,
  ts: string,
  agent: string | undefined,
): void {
  const hash = signalHash(event, agent);
  const existing = buckets.get(hash);
  if (existing) {
    existing.count++;
    existing.lastSeenAt = ts;
    if (existing.evidencePointers.length < 3)
      existing.evidencePointers.push(pointer);
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

function collectUserTurns(
  filePath: string,
  sinceMs: number,
): TranscriptUserTurn[] {
  const out: TranscriptUserTurn[] = [];
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let parsed: {
      type?: string;
      message?: { role?: string; content?: unknown };
      timestamp?: string;
      ts?: string;
    };
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
      if (obj.type === "text" && typeof obj.text === "string")
        parts.push(obj.text);
    }
  }
  return parts.join(" ");
}

function countRetries(
  turns: TranscriptUserTurn[],
  threshold: number,
  windowMs: number,
): number {
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

/**
 * Run all scanners and return the merged signal list.
 */
export function scanAll(opts: ScanOptions & UsageScanOptions = {}): Signal[] {
  return [
    ...scanDaemonLog(opts),
    ...scanUsage(opts),
    ...scanTranscripts(opts),
  ];
}
