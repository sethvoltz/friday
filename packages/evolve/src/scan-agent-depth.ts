/**
 * ADR-022 / FRI-102: surface "the system is nesting helpers deeper than
 * it should" as an evolve signal. The daemon emits one `agent.spawn`
 * line per spawn with `depth` (1 = orchestrator-rooted). We bucket
 * spawns at or above `AGENT_DEPTH_THRESHOLD` inside a rolling
 * `AGENT_DEPTH_WINDOW_HOURS` window; if more than
 * `AGENT_DEPTH_COUNT_THRESHOLD` are observed, we emit a single
 * proposal-only signal that the meta-agent can pick up. Below the
 * count threshold the scanner is silent.
 *
 * Thresholds are exported so they're tuneable from a single place once
 * we have real spawn traffic to look at — ADR-022 §"Open questions"
 * calls them out as placeholders.
 */

import { existsSync, readFileSync } from "node:fs";
import { DAEMON_LOG_PATH } from "@friday/shared";
import { signalHash } from "./scan.js";
import type { EvidencePointer, Signal } from "./types.js";

export const AGENT_DEPTH_THRESHOLD = 4;
export const AGENT_DEPTH_WINDOW_HOURS = 24;
export const AGENT_DEPTH_COUNT_THRESHOLD = 5;

export const AGENT_DEPTH_SIGNAL_KEY = "agent.spawn.deep-nesting";

export interface ScanAgentSpawnDepthOptions {
  /** Path to the daemon JSONL log. Defaults to DAEMON_LOG_PATH. */
  daemonLogPath?: string;
  /**
   * Inclusive lower bound on event `ts`, ISO string. Mirrors the
   * `since` field on the other scanners so `scanAll` can pass through
   * the same value. When provided, overrides `windowHours`.
   */
  since?: string;
  /** Override the rolling window. Defaults to AGENT_DEPTH_WINDOW_HOURS. */
  windowHours?: number;
  /** Override the depth threshold (`depth >= this counts`). */
  depthThreshold?: number;
  /** Override the count threshold (`strictly greater than this fires`). */
  countThreshold?: number;
  /** Current time for the rolling-window cutoff. Defaults to new Date(). */
  now?: Date;
}

interface SpawnLine {
  ts: string;
  depth: number;
  line: number;
}

/**
 * Walks daemon.jsonl for `agent.spawn` events, filters those with
 * `depth >= depthThreshold` within the rolling window, and emits one
 * signal if the count exceeds `countThreshold`. Strictly greater-than:
 * exactly `countThreshold` matches stays silent.
 */
export function scanAgentSpawnDepth(opts: ScanAgentSpawnDepthOptions = {}): Signal[] {
  const path = opts.daemonLogPath ?? DAEMON_LOG_PATH;
  if (!existsSync(path)) return [];

  const windowHours = opts.windowHours ?? AGENT_DEPTH_WINDOW_HOURS;
  const depthThreshold = opts.depthThreshold ?? AGENT_DEPTH_THRESHOLD;
  const countThreshold = opts.countThreshold ?? AGENT_DEPTH_COUNT_THRESHOLD;
  const now = opts.now ?? new Date();
  const cutoffMs = opts.since ? Date.parse(opts.since) : now.getTime() - windowHours * 3_600_000;

  const matches: SpawnLine[] = [];

  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let parsed: {
      ts?: string;
      event?: string;
      depth?: unknown;
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.event !== "agent.spawn") continue;
    if (typeof parsed.depth !== "number") continue;
    if (parsed.depth < depthThreshold) continue;
    const ts = parsed.ts;
    if (!ts) continue;
    const tsMs = Date.parse(ts);
    if (!Number.isFinite(tsMs)) continue;
    if (tsMs < cutoffMs) continue;
    matches.push({ ts, depth: parsed.depth, line: i + 1 });
  }

  if (matches.length <= countThreshold) return [];

  const evidencePointers: EvidencePointer[] = matches
    .slice(-3)
    .map((m) => ({ kind: "daemon", path, line: m.line }));

  const signal: Signal = {
    hash: signalHash(AGENT_DEPTH_SIGNAL_KEY, undefined),
    source: "daemon",
    key: AGENT_DEPTH_SIGNAL_KEY,
    severity: "low",
    count: matches.length,
    firstSeenAt: matches[0].ts,
    lastSeenAt: matches[matches.length - 1].ts,
    evidencePointers,
  };
  return [signal];
}
