/**
 * FRI-154: respawn-on-force-kill with anti-loop gate.
 *
 * When a worker is force-killed (stall watchdog SIGTERM, `forceKillStuckWorker`
 * for abort/stale/wedge/fsm-violation, external SIGKILL/OOM, `ulimit -t`
 * SIGXCPU, daemon-internal abort) with mail at `delivery='pending'` still
 * unprocessed, queue a fresh turn so the orphan mail isn't silently swallowed.
 *
 * Without this, the only auto-spawn path is `maybeSpawnFromMail`'s "fresh mail
 * to a non-live agent" trigger — which doesn't fire when a live worker dies
 * mid-flight with mail already on its inbox. User-visible symptom: mail
 * persists in the conversation DB, no model response, no error surfaced, user
 * has to manually nudge. See FRI-151 mail #365 for the canonical observation.
 *
 * Anti-loop design (the load-bearing piece, not the respawn itself):
 *
 *   - Per-agent in-memory tracker carries `attempts` + `firstAttemptAt`.
 *     Bounded — `attempts >= RESPAWN_MAX_ATTEMPTS` inside the rolling
 *     `RESPAWN_WINDOW_MS` triggers dead-letter instead of another respawn.
 *   - Exponential backoff: `min(2 ** attempts * RESPAWN_BACKOFF_BASE_MS,
 *     RESPAWN_BACKOFF_CAP_MS)`. attempts=0 → 1s, attempts=1 → 2s, attempts=2
 *     → 4s. Spreads spam in degenerate-loop cases.
 *   - `pendingTimer` presence is the idempotency gate. Back-to-back kills
 *     don't double-schedule.
 *   - On `turn-complete`, the tracker is cleared. A successful turn is the
 *     "the worker made forward progress" signal; without this, a long-lived
 *     agent that survived 2 respawns over months would dead-letter on the
 *     next unrelated death.
 *   - Dead-letter persists via a sentinel written into the mail row's
 *     `meta_json.dead_letter`. In-memory tracker resets on daemon restart
 *     (conservative — restart = clean slate); the sentinel does NOT, so the
 *     auto-respawn path on the next daemon boot still refuses to re-fire on
 *     the same rows.
 *
 * The respawn itself does NOT live here — it funnels back through
 * `maybeSpawnFromMail` (the existing surface) so the spawn logic isn't
 * duplicated. This module owns: detection, anti-loop accounting, scheduling,
 * dead-letter, and the cross-restart sentinel.
 */

import {
  inbox,
  isMailDeadLettered,
  markMailDeadLetter,
  type MailRow,
} from "@friday/shared/services";

import { isAgentLive } from "../agent/lifecycle.js";
import * as registry from "../agent/registry.js";
import { eventBus } from "../events/bus.js";
import { logger } from "../log.js";

import { maybeSpawnFromMail } from "./mail-bridge.js";

/* ---------------- tunables ---------------- */

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_CAP_MS = 30_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function respawnConfig(): {
  maxAttempts: number;
  windowMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
} {
  return {
    maxAttempts: envInt("FRIDAY_RESPAWN_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS),
    windowMs: envInt("FRIDAY_RESPAWN_WINDOW_MS", DEFAULT_WINDOW_MS),
    backoffBaseMs: envInt("FRIDAY_RESPAWN_BACKOFF_BASE_MS", DEFAULT_BACKOFF_BASE_MS),
    backoffCapMs: envInt("FRIDAY_RESPAWN_BACKOFF_CAP_MS", DEFAULT_BACKOFF_CAP_MS),
  };
}

/* ---------------- tracker ---------------- */

export interface RespawnTracker {
  attempts: number;
  firstAttemptAt: number;
  pendingTimer?: NodeJS.Timeout;
  deadLetteredAt?: number;
}

const trackers = new Map<string, RespawnTracker>();
const lastTurnCompleteAt = new Map<string, number>();

/** Test seam: snapshot the tracker for an agent (or null if absent). */
export function __peekTrackerForTest(agentName: string): RespawnTracker | null {
  return trackers.get(agentName) ?? null;
}

/** Test seam: wipe all in-memory state. */
export function __resetForTest(): void {
  for (const t of trackers.values()) {
    if (t.pendingTimer) clearTimeout(t.pendingTimer);
  }
  trackers.clear();
  lastTurnCompleteAt.clear();
}

/** Record that an agent just completed a turn successfully. Resets the
 *  per-agent respawn counter and stamps `lastSuccessfulTurnCompleteAt` for
 *  any future dead-letter event. */
export function noteTurnComplete(agentName: string): void {
  lastTurnCompleteAt.set(agentName, Date.now());
  const t = trackers.get(agentName);
  if (!t) return;
  if (t.pendingTimer) clearTimeout(t.pendingTimer);
  trackers.delete(agentName);
}

/** Cancel an in-flight respawn timer for `agentName`, if any. Called by the
 *  mail-bridge when a fresh mail arrival enters its own spawn branch — the
 *  fresh-mail path supersedes the timer and would otherwise race a duplicate
 *  spawn. Returns true if a timer was canceled. */
export function cancelPendingRespawn(agentName: string): boolean {
  const t = trackers.get(agentName);
  if (!t?.pendingTimer) return false;
  clearTimeout(t.pendingTimer);
  t.pendingTimer = undefined;
  return true;
}

/* ---------------- decision ---------------- */

export type RespawnDecision =
  | { kind: "skip"; reason: string }
  | { kind: "schedule"; delayMs: number; attemptsAfter: number }
  | {
      kind: "dead-letter";
      attempts: number;
      windowMs: number;
      unprocessedMailCount: number;
      lastSuccessfulTurnCompleteAt: number | null;
    };

/**
 * Pure decision function. Decides what to do for an agent given its mail and
 * its in-memory tracker state. No I/O — returned `RespawnDecision` is
 * executed by the caller. Extracted so the anti-loop math is unit-testable
 * without database / event bus mocks.
 *
 * Steps mirror the implementation-plan ordering in the FRI-154 ticket
 * comment; keep them in sync.
 */
export function decideRespawn(input: {
  now: number;
  isLive: boolean;
  isArchived: boolean;
  unprocessedCount: number;
  tracker: RespawnTracker | null;
  config: {
    maxAttempts: number;
    windowMs: number;
    backoffBaseMs: number;
    backoffCapMs: number;
  };
  lastSuccessfulTurnCompleteAt: number | null;
}): RespawnDecision {
  if (input.isLive) return { kind: "skip", reason: "agent-live" };
  if (input.isArchived) return { kind: "skip", reason: "agent-archived" };
  if (input.tracker?.pendingTimer) return { kind: "skip", reason: "timer-pending" };
  if (input.unprocessedCount === 0) return { kind: "skip", reason: "no-unprocessed-mail" };
  if (input.tracker?.deadLetteredAt) return { kind: "skip", reason: "dead-lettered" };

  const cfg = input.config;
  let attempts = input.tracker?.attempts ?? 0;
  if (input.tracker && input.now - input.tracker.firstAttemptAt > cfg.windowMs) {
    attempts = 0;
  }

  if (attempts >= cfg.maxAttempts) {
    return {
      kind: "dead-letter",
      attempts,
      windowMs: cfg.windowMs,
      unprocessedMailCount: input.unprocessedCount,
      lastSuccessfulTurnCompleteAt: input.lastSuccessfulTurnCompleteAt,
    };
  }

  const delayMs = Math.min(2 ** attempts * cfg.backoffBaseMs, cfg.backoffCapMs);
  return { kind: "schedule", delayMs, attemptsAfter: attempts + 1 };
}

/* ---------------- public entry point ---------------- */

/**
 * FRI-154 hook called from `child.on("exit")` in `lifecycle.ts`. Inspects the
 * agent's pending mail and the per-agent anti-loop tracker, then either
 * schedules a respawn, dead-letters, or no-ops. All branches are honest about
 * what they did via structured logs.
 *
 * `exitInfo` (`code`/`signal`) is captured into the dead-letter event for
 * operator triage — distinguishes OOM SIGKILL from a deliberate SIGTERM.
 */
export async function noteForceKillForRespawn(
  agentName: string,
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } = {
    code: null,
    signal: null,
  },
): Promise<void> {
  try {
    if (isAgentLive(agentName)) {
      logger.log("debug", "worker.respawn.skip", { agent: agentName, reason: "agent-live" });
      return;
    }

    const agentRow = await registry.getAgent(agentName);
    if (!agentRow) {
      logger.log("debug", "worker.respawn.skip", { agent: agentName, reason: "unknown-agent" });
      return;
    }
    if (agentRow.status === "archived") {
      logger.log("debug", "worker.respawn.skip", { agent: agentName, reason: "agent-archived" });
      return;
    }
    if (agentRow.type === "scheduled") {
      // Scheduled agents are driven by the cron tick; respawn would race the
      // scheduler and double-fire. Same exclusion as `maybeSpawnFromMail`.
      logger.log("debug", "worker.respawn.skip", { agent: agentName, reason: "scheduled-type" });
      return;
    }

    const pending = (await inbox(agentName)).filter((m) => !isMailDeadLettered(m));
    const tracker = trackers.get(agentName) ?? null;
    const cfg = respawnConfig();
    const decision = decideRespawn({
      now: Date.now(),
      isLive: false,
      isArchived: false,
      unprocessedCount: pending.length,
      tracker,
      config: cfg,
      lastSuccessfulTurnCompleteAt: lastTurnCompleteAt.get(agentName) ?? null,
    });

    switch (decision.kind) {
      case "skip":
        logger.log("debug", "worker.respawn.skip", { agent: agentName, reason: decision.reason });
        return;
      case "schedule":
        scheduleRespawn(agentName, decision.delayMs, decision.attemptsAfter, exitInfo);
        return;
      case "dead-letter":
        await emitDeadLetter(agentName, decision, pending, exitInfo);
        return;
    }
  } catch (err) {
    logger.log("warn", "worker.respawn.error", {
      agent: agentName,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function scheduleRespawn(
  agentName: string,
  delayMs: number,
  attemptsAfter: number,
  exitInfo: { code: number | null; signal: NodeJS.Signals | null },
): void {
  const now = Date.now();
  const existing = trackers.get(agentName);
  const firstAttemptAt =
    existing && now - existing.firstAttemptAt <= respawnConfig().windowMs
      ? existing.firstAttemptAt
      : now;
  const tracker: RespawnTracker = {
    attempts: attemptsAfter,
    firstAttemptAt,
    pendingTimer: setTimeout(() => {
      void fireScheduledRespawn(agentName);
    }, delayMs),
  };
  tracker.pendingTimer?.unref();
  trackers.set(agentName, tracker);
  logger.log("info", "worker.respawn.scheduled", {
    agent: agentName,
    delayMs,
    attempts: attemptsAfter,
    windowMs: respawnConfig().windowMs,
    exitCode: exitInfo.code,
    exitSignal: exitInfo.signal,
  });
}

async function fireScheduledRespawn(agentName: string): Promise<void> {
  const t = trackers.get(agentName);
  if (t) t.pendingTimer = undefined;
  // The fresh-mail bridge path may have raced us and already spawned a
  // worker (which `maybeSpawnFromMail`'s `isAgentLive` early-out then handled
  // identically). Call it anyway — the function is itself idempotent against
  // live workers and against an empty inbox.
  try {
    await maybeSpawnFromMail(agentName);
    logger.log("info", "worker.respawn.fired", {
      agent: agentName,
      attempts: t?.attempts ?? null,
    });
  } catch (err) {
    logger.log("warn", "worker.respawn.fire-error", {
      agent: agentName,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function emitDeadLetter(
  agentName: string,
  decision: Extract<RespawnDecision, { kind: "dead-letter" }>,
  pending: MailRow[],
  exitInfo: { code: number | null; signal: NodeJS.Signals | null },
): Promise<void> {
  const now = Date.now();
  // Persist the sentinel onto every pending row so a future daemon restart
  // doesn't re-arm the respawn cycle for these same orphans.
  for (const row of pending) {
    try {
      await markMailDeadLetter(row.id, {
        agent: agentName,
        at: now,
        attempts: decision.attempts,
      });
    } catch (err) {
      // Don't bail the dead-letter on one row — the in-memory + log surfaces
      // are still authoritative; missing-sentinel on one row only risks a
      // single extra respawn cycle on next restart.
      logger.log("warn", "worker.respawn.sentinel-write-error", {
        agent: agentName,
        mailId: row.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const existing = trackers.get(agentName);
  trackers.set(agentName, {
    attempts: decision.attempts,
    firstAttemptAt: existing?.firstAttemptAt ?? now,
    deadLetteredAt: now,
  });
  logger.log("warn", "worker.force-kill.dead-letter", {
    agent: agentName,
    attempts: decision.attempts,
    windowMs: decision.windowMs,
    unprocessedMailCount: decision.unprocessedMailCount,
    lastSuccessfulTurnCompleteAt: decision.lastSuccessfulTurnCompleteAt,
    exitCode: exitInfo.code,
    exitSignal: exitInfo.signal,
  });
  eventBus.publish({
    v: 1,
    type: "worker.force-kill.dead-letter",
    agent: agentName,
    attempts: decision.attempts,
    window_ms: decision.windowMs,
    unprocessed_mail_count: decision.unprocessedMailCount,
    last_successful_turn_complete_at: decision.lastSuccessfulTurnCompleteAt,
    ts: now,
  });
}
