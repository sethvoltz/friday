import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DAEMON_LOG_PATH } from "@friday/shared";
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
