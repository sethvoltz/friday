/**
 * Upgrade-aware proposal resolution.
 *
 * After `rerankAll`, walk the version boundaries in daemon.jsonl and
 * auto-resolve proposals whose signals have not recurred since the upgrade.
 *
 * Burst (crash-loop) → `status = "auto-resolved"`, `resolvedByUpgrade = true`
 * Sporadic           → `tentativelyResolvedByUpgrade = true`, score halved, status unchanged
 */

import { existsSync, readFileSync } from "node:fs";
import { DAEMON_LOG_PATH } from "@friday/shared";
import { listProposals, updateProposal } from "./store.js";

export interface VersionBoundary {
  ts: string;
  fromVersion: string;
  toVersion: string;
}

interface DaemonReadyLine {
  ts?: string;
  event?: string;
  version?: string;
  [key: string]: unknown;
}

/**
 * Walk daemon.jsonl and emit one VersionBoundary per daemon version change.
 * Same-version restarts and lines without a `version` field are skipped.
 */
export function readVersionBoundaries(logPath: string): VersionBoundary[] {
  if (!existsSync(logPath)) return [];

  const boundaries: VersionBoundary[] = [];
  let prevVersion: string | null = null;

  const raw = readFileSync(logPath, "utf-8");
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let parsed: DaemonReadyLine;
    try {
      parsed = JSON.parse(line) as DaemonReadyLine;
    } catch {
      continue;
    }
    if (parsed.event !== "daemon.ready") continue;
    if (typeof parsed.version !== "string") continue;
    if (typeof parsed.ts !== "string") continue;

    const version = parsed.version;
    if (prevVersion !== null && version !== prevVersion) {
      boundaries.push({ ts: parsed.ts, fromVersion: prevVersion, toVersion: version });
    }
    prevVersion = version;
  }

  return boundaries;
}

export interface ResolveByUpgradeOptions {
  daemonLogPath?: string;
}

const GRACE_MS = 6 * 60 * 60 * 1000; // 6 hours
const BURST_COUNT_THRESHOLD = 10;
const BURST_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Post-pass: for each open/critical proposal, find the first version boundary
 * after the cluster's lastSeenAt, require ≥ 6h grace, verify no recurrence,
 * then classify as definitive (auto-resolved) or tentative (score halved).
 */
export async function resolveByUpgrade(
  opts: ResolveByUpgradeOptions = {},
): Promise<{ definitive: number; tentative: number }> {
  const logPath = opts.daemonLogPath ?? DAEMON_LOG_PATH;
  const boundaries = readVersionBoundaries(logPath);
  if (boundaries.length === 0) return { definitive: 0, tentative: 0 };

  const proposals = listProposals();
  const now = Date.now();

  // Pre-build recurrence index: lines after a timestamp for (key, agent) pairs.
  // We read the log once and build a fast lookup structure.
  const recurrenceLines = buildRecurrenceIndex(logPath);

  let definitive = 0;
  let tentative = 0;

  for (const proposal of proposals) {
    if (proposal.status !== "open" && proposal.status !== "critical") continue;
    if (proposal.signals.length === 0) continue;

    // Find the cluster's lastSeenAt as the latest across all signals.
    const clusterLastSeenAt = proposal.signals.reduce((max, s) => {
      const ms = Date.parse(s.lastSeenAt);
      return Number.isFinite(ms) && ms > max ? ms : max;
    }, 0);
    if (clusterLastSeenAt === 0) continue;

    // Find earliest boundary after clusterLastSeenAt.
    const boundary = boundaries.find((b) => Date.parse(b.ts) > clusterLastSeenAt);
    if (!boundary) continue;

    const boundaryMs = Date.parse(boundary.ts);
    // Grace period: must be ≥ 6h since the boundary.
    if (now - boundaryMs < GRACE_MS) continue;

    // Check for recurrence of any (key, agent) pair after the boundary.
    const hasRecurrence = proposal.signals.some((signal) => {
      const signalKey = `${signal.key}\0${signal.agent ?? ""}`;
      const occurrences = recurrenceLines.get(signalKey);
      if (!occurrences) return false;
      return occurrences.some((ts) => Date.parse(ts) > boundaryMs);
    });
    if (hasRecurrence) continue;

    // Classify: burst (crash-loop) vs sporadic.
    const isBurst = proposal.signals.some((s) => {
      if (s.count <= BURST_COUNT_THRESHOLD) return false;
      const spanMs = Date.parse(s.lastSeenAt) - Date.parse(s.firstSeenAt);
      return Number.isFinite(spanMs) && spanMs <= BURST_WINDOW_MS;
    });

    if (isBurst) {
      updateProposal(proposal.id, {
        status: "auto-resolved",
        resolvedByUpgrade: true,
        resolvedByVersion: boundary.toVersion,
        resolvedAt: boundary.ts,
      });
      definitive++;
    } else {
      updateProposal(proposal.id, {
        tentativelyResolvedByUpgrade: true,
        resolvedByVersion: boundary.toVersion,
        resolvedAt: boundary.ts,
        score: Math.max(0, Math.floor(proposal.score * 0.5)),
      });
      tentative++;
    }
  }

  return { definitive, tentative };
}

/**
 * Read daemon.jsonl and build a map from `"key\0agent"` to the list of
 * timestamps at which that (event, agent) pair appeared.
 */
function buildRecurrenceIndex(logPath: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  if (!existsSync(logPath)) return index;

  const raw = readFileSync(logPath, "utf-8");
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let parsed: { ts?: string; event?: string; agent?: string };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    if (!parsed.event || !parsed.ts) continue;
    const agent = typeof parsed.agent === "string" ? parsed.agent : "";
    const key = `${parsed.event}\0${agent}`;
    const existing = index.get(key);
    if (existing) {
      existing.push(parsed.ts);
    } else {
      index.set(key, [parsed.ts]);
    }
  }
  return index;
}
