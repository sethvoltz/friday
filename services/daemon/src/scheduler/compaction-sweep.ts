/**
 * FRI-156 §B — nightly maintenance compaction sweep.
 *
 * A daemon-internal timer that, once per night (default 03:30 local),
 * dispatches a `/compact <persona instructions>` maintenance turn to each
 * long-lived, currently-idle agent whose estimated live context has crept
 * above the sweep threshold (default 60K tokens). This is the LOW number in
 * the two-number scheme: the sweep keeps wakes cheap (~60K) and the per-agent
 * `settings.autoCompactWindow` SDK ceiling (200K, FRI-156 §A) is the runaway-
 * day backstop.
 *
 * Explicitly NOT a schedules-table row, NOT a scheduled agent, NOT an
 * agent-run schedule — it must never surface in the user-facing schedules UI.
 * Modeled on agent/watchdog.ts: an unref'd setInterval, a `__runSweepForTest`
 * seam, and its own start/stop. The pure core (`isSweepDue`,
 * `selectSweepTargets`) is clock-injected and exported so the policy is unit-
 * testable without fake timers — matching the repo's injected-`now` scheduler-
 * test convention.
 *
 * Idempotency: `lastSweepAt` is in-memory module state and `isSweepDue` dedups
 * per local day. `isSweepDue` also bounds firing to a catch-up WINDOW after the
 * scheduled time (`SWEEP_WINDOW_MINUTES`) so a daytime daemon restart (fresh
 * `lastSweepAt === null`) does NOT immediately mass-compact — it waits for the
 * next night. The 60K threshold gate is the further backstop against an
 * overnight restart re-sweeping — a session that was just compacted sits below
 * threshold, so a same-day second pass selects nothing.
 */

import {
  compactionSweepHour,
  compactionSweepMinute,
  compactionSweepThreshold,
  loadConfig,
  resolveDaemonPort,
  resolveModelForRole,
  type AgentEntry,
  type AgentType,
  type FridayConfig,
} from "@friday/shared";
import { estimateContextTokens, getLatestUsageForAgent } from "@friday/shared/services";
import { randomUUID } from "node:crypto";
import { logger } from "../log.js";
import { buildSystemPrompt } from "../prompts/build-system-prompt.js";
import { COMPACT_CUSTOM_INSTRUCTIONS } from "../prompts/compact-instructions.js";
import { recordUserBlock } from "../agent/block-injectors.js";
import { dispatchTurn, liveAgentNames, peekLiveWorker } from "../agent/lifecycle.js";
import * as registry from "../agent/registry.js";

/** ~5-minute poll. The per-day dedup in `isSweepDue` prevents repeat fires
 *  within a single night, so the interval only has to be fine-grained enough
 *  to catch the 03:30 window soon after it opens. */
const TICK_MS = 300_000;

/** Width (minutes) of the catch-up window after the scheduled sweep time.
 *  The sweep fires only when `now` falls within `[scheduled, scheduled +
 *  SWEEP_WINDOW_MINUTES)`. WITHOUT this bound an `afterTime` check is open
 *  until midnight, so a fresh process (in-memory `lastSweepAt === null`)
 *  started any time after 03:30 — e.g. a daytime `friday update` restart at
 *  14:00 — would immediately mass-compact every over-threshold idle agent
 *  instead of waiting for the next 03:30. 2h tolerates a daemon that was down
 *  at exactly 03:30 and boots shortly after, while keeping the sweep nightly. */
const SWEEP_WINDOW_MINUTES = 120;

/** Long-lived companion types eligible for the nightly sweep. Builders are
 *  excluded (read-only memory + mid-task tool stream); scheduled/planner are
 *  one-shot or bounded handoff work. */
const SWEEP_ELIGIBLE_TYPES = new Set<AgentType>(["orchestrator", "helper", "bare"]);

function isSweepEligibleType(type: AgentType): boolean {
  return SWEEP_ELIGIBLE_TYPES.has(type);
}

let interval: NodeJS.Timeout | null = null;
/** Epoch-ms of the last completed sweep pass; null until the first runs.
 *  In-memory only — see the idempotency note in the module doc-comment. */
let lastSweepAt: number | null = null;
/** Re-entrancy guard. `lastSweepAt` is only written at the END of a pass, after
 *  the await-heavy listAgents → per-agent usage → dispatch loop, so a single
 *  pass slower than the 5-min tick would let a second tick enter `runSweep` and
 *  re-pass `isSweepDue` before the first records its timestamp — both selecting
 *  and dispatching the same agents. This flag makes an overlapping tick a clean
 *  no-op independent of the per-target TOCTOU re-check. */
let sweepRunning = false;

export interface SweepCandidate {
  name: string;
  type: AgentType;
  estimatedContext: number;
}

/**
 * True when `now`'s LOCAL time falls inside the catch-up window
 * `[scheduled, scheduled + SWEEP_WINDOW_MINUTES)` AND we haven't already swept
 * today. Pure local-clock comparison (NOT cron): 03:30 daily needs no cron
 * expressiveness, and an injected `now` makes this trivially testable.
 *
 * The bounded window is what keeps the sweep NIGHTLY across restarts: a fresh
 * process has `lastSweepAt === null`, so without an upper bound any daytime
 * restart after 03:30 would fire immediately. With the window, a 14:00 restart
 * is outside `[03:30, 05:30)` and waits for the next night.
 *
 * "Already swept today" is a same-local-day comparison of `lastSweepAt` against
 * `now` — so a sweep that ran at 03:30 won't re-fire at 03:35 on the same day,
 * but a fresh day re-arms it.
 */
export function isSweepDue(now: Date, lastSweepAt: number | null, cfg: FridayConfig): boolean {
  const hour = compactionSweepHour(cfg);
  const minute = compactionSweepMinute(cfg);
  const scheduledMinutes = hour * 60 + minute;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const minutesSinceScheduled = nowMinutes - scheduledMinutes;
  // Inside the window only: at/after the scheduled time, but not so far past it
  // that a daytime restart counts as a missed nightly run.
  if (minutesSinceScheduled < 0 || minutesSinceScheduled >= SWEEP_WINDOW_MINUTES) return false;
  if (lastSweepAt === null) return true;
  const last = new Date(lastSweepAt);
  const sameLocalDay =
    last.getFullYear() === now.getFullYear() &&
    last.getMonth() === now.getMonth() &&
    last.getDate() === now.getDate();
  return !sameLocalDay;
}

/**
 * The pure target-selection policy. An agent is swept only when ALL hold:
 *   - its type is `orchestrator`, `helper`, or `bare` (long-lived companion
 *     types, including app bare agents such as kitchen); builders are skipped
 *     (read-only memory + mid-task tool stream), as are scheduled/planner;
 *   - it is currently LIVE and IDLE (`liveStatus.get(name) === 'idle'`) — the
 *     sweep never wakes an offline registered agent (no live context pressure)
 *     and never interrupts a working/stalled turn;
 *   - the registry status is not working/stalled/archived/archive_requested
 *     (a belt-and-suspenders check alongside the live-status gate);
 *   - its estimated live context exceeds the sweep threshold.
 */
export function selectSweepTargets(
  agents: AgentEntry[],
  liveStatus: Map<string, "idle" | "working" | null>,
  usageByAgent: Map<string, number>,
  cfg: FridayConfig,
): SweepCandidate[] {
  const threshold = compactionSweepThreshold(cfg);
  const out: SweepCandidate[] = [];
  for (const a of agents) {
    if (!isSweepEligibleType(a.type)) continue;
    // Registry-side gate: only a settled idle agent qualifies.
    if (a.status !== "idle") continue;
    // Live-side gate: must be live AND idle right now (not offline, not working).
    if (liveStatus.get(a.name) !== "idle") continue;
    const estimate = usageByAgent.get(a.name) ?? 0;
    if (estimate <= threshold) continue;
    out.push({ name: a.name, type: a.type, estimatedContext: estimate });
  }
  return out;
}

/**
 * Build the imperative liveStatus map from the live worker registry: an agent
 * maps to its live worker's status, or `null` when it has no live worker
 * (offline). `selectSweepTargets` treats anything but `'idle'` as ineligible.
 */
function buildLiveStatus(): Map<string, "idle" | "working" | null> {
  const liveStatus = new Map<string, "idle" | "working" | null>();
  for (const name of liveAgentNames()) {
    liveStatus.set(name, peekLiveWorker(name)?.status ?? null);
  }
  return liveStatus;
}

/**
 * Estimated live context for one agent: the input + cache-read + cache-creation
 * of its latest usage row, scoped to its CURRENT sessionId so a cleared/rotated
 * old session's tokens can't trigger a phantom sweep. Returns 0 when there's no
 * usage row (a never-run or freshly-cleared agent sits below threshold).
 */
async function estimateAgentContext(a: AgentEntry): Promise<number> {
  const row = await getLatestUsageForAgent(a.name, a.sessionId ?? undefined);
  if (!row) return 0;
  return estimateContextTokens(row);
}

/**
 * Dispatch one `/compact …` maintenance turn to a target agent. Mirrors the
 * watchdog refork dispatch + the scheduler spawn: build the system prompt via
 * `buildSystemPrompt` (which fires NO before_prompt_build hooks), record an
 * originating user block (FRI-71 — the dashboard renders the user bubble), and
 * fire-and-forget `dispatchTurn` in long-lived mode.
 *
 * The body is built LITERALLY as `/compact ${COMPACT_CUSTOM_INSTRUCTIONS}` and
 * is NOT routed through `buildDispatchPrompt`: the leading `/compact ` is
 * load-bearing (the SDK's claude_code preset interprets it as the native slash
 * command — the runtime-proven compaction path), and a future
 * `before_prompt_build` prependBody hook could silently break that prefix. The
 * `compact` DispatchIntent kind exists for any path that DOES go through
 * buildDispatchPrompt; the sweep deliberately does not.
 *
 * Returns `true` if a turn was dispatched, `false` if the agent went
 * non-idle during the prep awaits (TOCTOU) and was skipped.
 */
async function dispatchSweep(name: string, cfg: FridayConfig): Promise<boolean> {
  const a = await registry.getAgent(name);
  if (!a) return false;
  const workingDirectory = await registry.workingDirectoryFor(a);
  const { systemPrompt } = await buildSystemPrompt(a);
  // TOCTOU re-check AFTER the prep awaits (getAgent / workingDirectoryFor /
  // buildSystemPrompt all yield the event loop). runSweep re-checked liveness
  // before calling us, but the agent can flip idle→working during these awaits
  // (a worker-internal mail wakeup or a queued user prompt draining). If it
  // has, dispatchTurn would PUSH the /compact onto nextPrompts (queue behind
  // live work) — exactly what §B says to avoid. Skip rather than queue, and
  // do NOT record a user block for a turn we won't dispatch.
  if (peekLiveWorker(name)?.status !== "idle") return false;
  const modelCfg = resolveModelForRole(cfg, a.type);
  const turnId = `t_${randomUUID()}`;
  // Leading "/compact " is load-bearing — see the doc-comment above.
  const body = `/compact ${COMPACT_CUSTOM_INSTRUCTIONS}`;

  // FRI-71: persist the originating user block so the compaction turn's
  // assistant output renders against a user bubble instead of dangling. The
  // dedicated `compaction_sweep` source keeps this autonomous overnight turn
  // distinct in the audit trail from a user-typed /compact.
  //
  // The recorded bubble carries a SHORT label — not the full ~10-line persona
  // instruction body — so the orchestrator chat doesn't accumulate a verbose
  // "/compact You are compacting…" block next to the divider every night. The
  // worker still receives the complete `body` below; only the rendered user
  // bubble is abbreviated.
  await recordUserBlock({
    turnId,
    agentName: name,
    sessionId: a.sessionId ?? undefined,
    text: "/compact (nightly maintenance)",
    source: "compaction_sweep",
  });

  dispatchTurn({
    agentName: name,
    options: {
      agentName: name,
      agentType: a.type,
      workingDirectory,
      systemPrompt,
      prompt: body,
      turnId,
      model: modelCfg.name,
      thinking: modelCfg.thinking,
      effort: modelCfg.effort,
      resumeSessionId: a.sessionId ?? undefined,
      daemonPort: resolveDaemonPort(cfg),
      parentName: "parentName" in a ? (a.parentName ?? undefined) : undefined,
      mode: "long-lived",
    },
  });
  return true;
}

/**
 * One sweep pass. No-op unless the local clock has reached the sweep time and
 * we haven't swept today. Re-checks the live+idle race per target right before
 * dispatch (an agent that started a turn between selection and dispatch is
 * skipped). Sets `lastSweepAt` after the pass regardless of how many targets
 * fired, so a due window produces exactly one pass per day.
 */
async function runSweep(now: Date = new Date()): Promise<void> {
  const cfg = loadConfig();
  if (!isSweepDue(now, lastSweepAt, cfg)) return;
  // Re-entrancy guard: if a prior pass is still mid-flight (its await-heavy body
  // hasn't yet written `lastSweepAt`), a fresh tick would re-pass `isSweepDue`
  // and re-select the same agents. Bail cleanly so overlap can't double-dispatch.
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const agents = await registry.listAgents();
    const liveStatus = buildLiveStatus();
    const usageByAgent = new Map<string, number>();
    for (const a of agents) {
      // Only the candidate types can be swept — skip the usage query for the
      // rest so a wide registry doesn't fan out into needless reads.
      if (!isSweepEligibleType(a.type)) continue;
      usageByAgent.set(a.name, await estimateAgentContext(a));
    }

    const targets = selectSweepTargets(agents, liveStatus, usageByAgent, cfg);
    const threshold = compactionSweepThreshold(cfg);
    logger.log("info", "worker.compact.sweep.started", { targetCount: targets.length });

    for (const t of targets) {
      // Race re-check: an agent that began a turn since selection is no longer
      // idle — skip it rather than queue a /compact behind live work.
      if (peekLiveWorker(t.name)?.status !== "idle") {
        logger.log("info", "worker.compact.sweep.skipped", {
          agent: t.name,
          reason: "no-longer-idle",
        });
        continue;
      }
      try {
        const dispatched = await dispatchSweep(t.name, cfg);
        if (!dispatched) {
          // The agent went non-idle (or vanished) during dispatchSweep's prep
          // awaits — skipped rather than queued behind live work (TOCTOU).
          logger.log("info", "worker.compact.sweep.skipped", {
            agent: t.name,
            reason: "no-longer-idle",
          });
          continue;
        }
        logger.log("info", "worker.compact.sweep.dispatched", {
          agent: t.name,
          estimate: t.estimatedContext,
          threshold,
        });
      } catch (err) {
        logger.log("warn", "worker.compact.sweep.error", {
          agent: t.name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    lastSweepAt = Date.now();
  } finally {
    sweepRunning = false;
  }
}

export function startCompactionSweep(): NodeJS.Timeout {
  if (interval) return interval;
  interval = setInterval(
    () =>
      void runSweep().catch((err) =>
        logger.log("warn", "worker.compact.sweep.error", { message: String(err) }),
      ),
    TICK_MS,
  );
  interval.unref();
  return interval;
}

export function stopCompactionSweep(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  lastSweepAt = null;
  sweepRunning = false;
}

/**
 * Test seam (mirrors watchdog's `__tickForTest`): drive a single sweep pass
 * synchronously with an injected `now`, awaiting its I/O. Not for production.
 */
export async function __runSweepForTest(now: Date): Promise<void> {
  await runSweep(now);
}

/** Test-only: reset the in-memory `lastSweepAt` dedup so suites don't leak
 *  a prior pass's timestamp across cases. */
export function __resetLastSweepForTest(): void {
  lastSweepAt = null;
  sweepRunning = false;
}
