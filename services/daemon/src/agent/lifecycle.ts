/**
 * Worker lifecycle: forks per-agent processes, owns the IPC channel, and
 * routes events to the daemon's eventBus. Each forked worker can be either
 * one-shot (scheduled) or long-lived (orchestrator/builder/helper/bare).
 *
 * Long-lived semantics:
 *   - The first turn arrives via spawnTurn() with the initial prompt.
 *   - Subsequent turns arrive via dispatchTurn(); if the agent is already
 *     live we send a `prompt` IPC instead of forking.
 *   - turn-complete from the worker emits `turn_done` and inserts usage,
 *     but does NOT shut the worker down — the worker drives its own loop
 *     (drain mail, idle, repeat).
 *   - If a new prompt arrives while the worker is mid-turn, we queue it
 *     parent-side and flush on the next turn-complete so events from the
 *     in-flight turn keep their original turn_id.
 */

import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentType, BlockKind } from "@friday/shared";
import { loadConfig } from "@friday/shared";
import {
  insertBlock,
  insertUsage,
  updateBlock,
  type BlockSource,
} from "@friday/shared/services";
import { eventBus } from "../events/bus.js";
import { logger } from "../log.js";
import * as registry from "./registry.js";
import * as liveTurns from "./live-turns.js";
import {
  profileInputsFor,
  removeProfile,
  sandboxExecAvailable,
  writeProfile,
} from "./sandbox-profile.js";
import type {
  WorkerCommand,
  WorkerEvent,
  WorkerPromptCommand,
  WorkerSpawnOptions,
} from "./worker-protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, "worker.js");

export interface ExitInfo {
  sessionId?: string;
  durationMs: number;
  /** Whether the parent observed a turn-complete before the exit. */
  completed: boolean;
  status: "complete" | "aborted" | "error";
}

export interface LiveWorker {
  child: ChildProcess;
  /** Process-group id of the worker. With `detached: true` this equals
   * child.pid, which lets `kill(-pgid)` reap descendants the worker leaked
   * (e.g. `(sleep 200 &); disown`). In-memory only — not persisted, since
   * boot recovery deliberately doesn't reap by stored pgid (PID-reuse risk
   * on a long daemon downtime). */
  pgid: number;
  agentName: string;
  agentType: AgentType;
  model: string;
  /** Active turn id; updated on each prompt dispatch. */
  turnId: string;
  sessionId?: string;
  /** The cwd the SDK runs under (== JSONL transcript dir). For builders this
   * is the worktree path; for in-process types it's the daemon's cwd. The
   * JSONL mirror needs this to compute the right ~/.claude/projects file. */
  workingDirectory: string;
  abortRequested: boolean;
  lastHeartbeat: number;
  /** Wall-clock start of the *current* turn, for usage duration. */
  turnStart: number;
  /** Wall-clock start of the worker process; used for one-shot duration. */
  spawnedAt: number;
  /** Wall-clock of the most recent block-stop. The turn-stall timer uses
   * this as the "model is making progress" signal — heartbeats don't count
   * because a stuck SDK still emits them. */
  lastBlockStop: number;
  /** Idle vs working, mirrored from worker `status-change` events. */
  status: "idle" | "working";
  /**
   * FIFO of prompts that arrived while a previous turn was in flight. Drained
   * on each turn-complete so per-turn events stay tagged with the correct
   * turn_id.
   */
  nextPrompts: WorkerPromptCommand[];
  mode: "long-lived" | "one-shot";
  /** Set by handleEvent on turn-complete; consumed by onExit. */
  lastExitStatus: "complete" | "aborted" | "error";
  completedAtLeastOnce: boolean;
  onExit?: (info: ExitInfo) => void;
}

const live = new Map<string, LiveWorker>();

/**
 * SIGTERM (or SIGKILL) the entire process group of a worker. With
 * `detached:true` at fork time, the worker's pgid is the same as its pid,
 * and `process.kill(-pgid, sig)` reaches every descendant — including
 * `(sleep 200 &); disown` style leaks that wouldn't be caught by killing
 * the worker pid alone. Safe to call even when the group is already gone;
 * ESRCH is swallowed.
 *
 * Exported only so the integration test can drive it directly against a
 * real subprocess tree.
 */
export function killPgrp(pgid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (!pgid || pgid <= 1) return;
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") {
      logger.log("warn", "worker.pgrp.kill.fail", {
        pgid,
        signal,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export interface SpawnTurnInput {
  agentName: string;
  options: WorkerSpawnOptions;
  /** Called when the worker process exits. Used by scheduled to write last-run.md. */
  onExit?: (info: ExitInfo) => void;
}

/**
 * Forks a fresh worker for `agentName` and starts the initial turn. Throws
 * if the agent already has a live worker — the caller should use
 * `dispatchTurn` instead, which handles both fork and reuse.
 */
export function spawnTurn(input: SpawnTurnInput): void {
  if (live.has(input.agentName)) {
    throw new Error(`agent "${input.agentName}" already has a live worker`);
  }
  registry.setStatus(input.agentName, "working");

  // M2: builders run under `sandbox-exec` so the kernel denies writes to
  // credentials, dotfiles, LaunchAgents, Keychains, and Friday's own state
  // even if the M1 PreToolUse hook misses (e.g. a PATH-wrapped binary that
  // the regex didn't spot). Non-builder agents run with the daemon's
  // permissions because their working directory is the daemon repo and
  // they legitimately need broader filesystem access.
  const sandboxStatus = sandboxExecAvailable();
  const wrapWithSandbox =
    input.options.agentType === "builder" && sandboxStatus.available;
  let profilePath: string | undefined;
  if (wrapWithSandbox) {
    profilePath = writeProfile(
      input.agentName,
      profileInputsFor(input.options.workingDirectory),
    );
  }

  logger.log("info", "worker.fork", {
    agent: input.agentName,
    type: input.options.agentType,
    mode: input.options.mode,
    turnId: input.options.turnId,
    resumeSessionId: input.options.resumeSessionId ?? null,
    sandboxed: wrapWithSandbox,
    sandboxReason: wrapWithSandbox ? "ok" : sandboxStatus.reason,
  });

  // env block shared between worker spawn paths.
  //
  // We deliberately do NOT set NPM_CONFIG_IGNORE_SCRIPTS / equivalent here.
  // pnpm v9+ already requires explicit opt-in via `pnpm.onlyBuiltDependencies`
  // (or `pnpm approve-builds`) before any postinstall fires — a blanket
  // disable would break legitimate flows like Husky `prepare` hooks and
  // repo-vetted native-module builds. M1's package-manager rule keeps npm /
  // yarn behind `--ignore-scripts` (those run all postinstalls by default);
  // for pnpm we trust the repo's own gating.
  const env = {
    ...process.env,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    CI: "1",
  };

  // M5: ulimit wrapper for CPU + nofile. The bash prelude applies the
  // rlimits before exec'ing node so the limits are in effect from worker.js
  // line 0. `exec "$@"` passes positional args through unmodified, avoiding
  // shell quoting of paths.
  //
  // Defaults: 1h CPU (catches honest infinite loops without hitting on
  // legitimate long Builder turns; wall-clock is enforced by the M5 turn
  // stall watchdog separately), 4096 file descriptors (generous).
  // Overridable via env for emergency tuning.
  const cpuLimit = process.env.FRIDAY_WORKER_CPU_LIMIT ?? "3600";
  const nofileLimit = process.env.FRIDAY_WORKER_NOFILE_LIMIT ?? "4096";
  const ULIMIT_PRELUDE = `ulimit -t ${cpuLimit}; ulimit -n ${nofileLimit}; exec "$@"`;

  const spawnOpts: SpawnOptions = {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    // M4: detached makes the worker its own process-group leader so we can
    // SIGTERM the whole group on destroy. Without this, a leaked descendant
    // (`(sleep 200 &); disown`) survives the worker exit.
    detached: true,
    env,
  };

  // Both paths terminate in `bash -c 'ulimit …; exec "$@"' -- node <execArgv> WORKER`.
  // The triple chain (sandbox-exec → bash → node) preserves NODE_CHANNEL_FD
  // through both exec()s; verified by sandbox-profile-kernel.test.ts and
  // lifecycle-spawn-ipc.test.ts.
  //
  // We forward `process.execArgv` so loader hooks on the parent (`--import
  // tsx/esm` under `tsx watch`, `--experimental-vm-modules`, etc.) reach the
  // worker too — otherwise the worker's plain `node WORKER_PATH` can't
  // resolve `.ts` sources in dev. `fork()` does this implicitly; we have to
  // do it ourselves now that we go through bash.
  const nodeArgs = [...process.execArgv, WORKER_PATH];
  const child: ChildProcess = wrapWithSandbox
    ? spawn(
        "/usr/bin/sandbox-exec",
        [
          "-f",
          profilePath!,
          "/bin/bash",
          "-c",
          ULIMIT_PRELUDE,
          "--",
          process.execPath,
          ...nodeArgs,
        ],
        spawnOpts,
      )
    : spawn(
        "/bin/bash",
        ["-c", ULIMIT_PRELUDE, "--", process.execPath, ...nodeArgs],
        spawnOpts,
      );
  // With detached:true the child is the leader of its own process group, so
  // pgid === child.pid. If fork failed pid will be undefined; we keep 0 as
  // a sentinel so killPgrp can skip safely.
  const pgid = child.pid ?? 0;
  const w: LiveWorker = {
    child,
    pgid,
    agentName: input.agentName,
    agentType: input.options.agentType,
    model: input.options.model,
    turnId: input.options.turnId,
    workingDirectory: input.options.workingDirectory,
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now(),
    spawnedAt: Date.now(),
    lastBlockStop: Date.now(),
    status: "working",
    nextPrompts: [],
    mode: input.options.mode,
    lastExitStatus: "complete",
    completedAtLeastOnce: false,
    onExit: input.onExit,
  };
  live.set(input.agentName, w);

  child.on("message", (raw: unknown) => {
    handleEvent(w, raw as WorkerEvent);
  });
  child.on("exit", (code, signal) => {
    logger.log("info", "worker.exit", {
      agent: input.agentName,
      code,
      signal,
    });
    // M2: clean up the per-worker SBPL profile. Best-effort; the file is
    // owner-only and idempotent so a leak is harmless beyond the disk space.
    if (profilePath) removeProfile(profilePath);
    // If the worker died mid-turn the in-flight registry entry would leak —
    // drop it here so the daemon doesn't hold accumulator state for a turn
    // that can no longer make progress.
    liveTurns.dropTurn(w.turnId);
    live.delete(input.agentName);
    registry.setStatus(input.agentName, "idle");
    eventBus.publish({
      v: 1,
      type: "agent_lifecycle",
      agent: input.agentName,
      agentType: input.options.agentType,
      parentName: input.options.parentName,
      event: "complete",
    });
    if (w.onExit) {
      const status: ExitInfo["status"] = w.completedAtLeastOnce
        ? w.lastExitStatus
        : code === 0
          ? "complete"
          : "error";
      try {
        w.onExit({
          sessionId: w.sessionId,
          durationMs: Date.now() - w.spawnedAt,
          completed: w.completedAtLeastOnce,
          status,
        });
      } catch (err) {
        logger.log("warn", "worker.onexit.error", {
          agent: input.agentName,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  // Send `start` after the worker emits its first `ready`. Inject
  // user-configured MCP servers from `~/.friday/config.json` here so callers
  // don't each have to remember to wire them; tests can pre-set
  // `input.options.userMcpServers` to bypass the disk read.
  child.once("message", () => {
    const userMcpServers =
      input.options.userMcpServers ?? loadConfig().mcpServers ?? [];
    send(child, {
      type: "start",
      options: { ...input.options, userMcpServers },
    });
  });

  eventBus.publish({
    v: 1,
    type: "agent_lifecycle",
    agent: input.agentName,
    agentType: input.options.agentType,
    parentName: input.options.parentName,
    event: "spawn",
  });
  eventBus.publish({
    v: 1,
    type: "turn_started",
    turn_id: input.options.turnId,
    agent: input.agentName,
    ts: Date.now(),
  });
}

/**
 * Smart entrypoint for "send a turn to this agent". Forks a fresh worker if
 * the agent isn't live; otherwise sends a `prompt` IPC (or queues it if the
 * worker is mid-turn).
 */
export function dispatchTurn(input: SpawnTurnInput): void {
  const existing = live.get(input.agentName);
  if (!existing) {
    spawnTurn(input);
    return;
  }
  const promptCmd: WorkerPromptCommand = {
    prompt: input.options.prompt,
    turnId: input.options.turnId,
    resumeSessionId:
      input.options.resumeSessionId ?? existing.sessionId ?? undefined,
    allowedToolsOverride: input.options.allowedToolsOverride,
  };
  if (existing.status === "idle") {
    sendPrompt(existing, promptCmd);
  } else {
    existing.nextPrompts.push(promptCmd);
    // FIX_FORWARD 2.4: signal the worker so it can break at the next SDK
    // iteration boundary. The worker emits `turn-complete` on the break;
    // our existing turn-complete handler then pops nextPrompts and sends
    // the queued prompt forward via the normal `prompt` IPC.
    send(existing.child, { type: "prompts-pending" });
    logger.log("info", "worker.prompt.queued", {
      agent: input.agentName,
      turnId: promptCmd.turnId,
      depth: existing.nextPrompts.length,
    });
  }
}

function sendPrompt(w: LiveWorker, p: WorkerPromptCommand): void {
  w.turnId = p.turnId;
  w.turnStart = Date.now();
  w.abortRequested = false;
  w.status = "working";
  registry.setStatus(w.agentName, "working");
  eventBus.publish({
    v: 1,
    type: "turn_started",
    turn_id: p.turnId,
    agent: w.agentName,
    ts: Date.now(),
  });
  send(w.child, { type: "prompt", options: p });
}

export function abortTurn(agentName: string): boolean {
  const w = live.get(agentName);
  if (!w) return false;
  w.abortRequested = true;
  send(w.child, { type: "abort" });
  return true;
}

/**
 * Tear down a live worker and clean its registry row. FIX_FORWARD 4.1: the
 * returned promise resolves only after the child process has actually
 * exited (or after a 5s SIGKILL fallback fires). The watchdog's refork
 * path awaits this so it can't race the next fork against the dying
 * worker's lingering IPC traffic.
 *
 * Fire-and-forget callers (REST kill endpoints, system commands) can
 * ignore the returned promise — the side-effects (registry destroy,
 * agent_lifecycle event, live-map remove) happen synchronously up front.
 */
export function killAgent(agentName: string): Promise<void> {
  const w = live.get(agentName);
  // Synchronous side-effects: drop from the live map so subsequent
  // dispatchTurn / wakeAgent / etc. see a clean slate immediately, even
  // before the child has fully exited.
  if (w) live.delete(agentName);
  registry.destroyAgent(agentName);
  eventBus.publish({
    v: 1,
    type: "agent_lifecycle",
    agent: agentName,
    agentType: w?.agentType ?? "orchestrator",
    event: "kill",
  });
  if (!w) return Promise.resolve();

  // Ask the worker to stop gracefully, then wait for the actual exit
  // event. SIGTERM-on-pgrp backstop at 5s catches descendants the worker
  // leaked; SIGKILL-on-pgrp at 7s is the hard floor.
  send(w.child, { type: "stop" });
  if (w.child.exitCode !== null || w.child.killed) {
    // Child is already gone, but descendants may still be running.
    killPgrp(w.pgid, "SIGTERM");
    setTimeout(() => killPgrp(w.pgid, "SIGKILL"), 2_000).unref();
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    w.child.once("exit", () => {
      // Even on clean child exit, send a pgrp SIGTERM to reap any leaked
      // descendants (`(sleep &); disown`). No-op if the group is empty.
      killPgrp(w.pgid, "SIGTERM");
      setTimeout(() => killPgrp(w.pgid, "SIGKILL"), 2_000).unref();
      finish();
    });
    setTimeout(() => {
      if (done) return;
      // Graceful stop ignored — SIGTERM the whole pgrp (catches leaked
      // descendants too). The `exit` listener resolves the promise once
      // the kernel reaps the worker process.
      killPgrp(w.pgid, "SIGTERM");
      // 2 s after that, SIGKILL the group if anything is still alive.
      setTimeout(() => killPgrp(w.pgid, "SIGKILL"), 2_000).unref();
    }, 5_000).unref();
  });
}

/**
 * Synchronously SIGTERM every live worker's process group. Called from the
 * daemon shutdown handler so descendants don't get orphaned to launchd on
 * normal SIGTERM/SIGINT. Doesn't wait for exits — the daemon shutdown has
 * its own 2 s ceiling.
 */
export function reapAllLiveWorkers(): void {
  for (const w of live.values()) {
    killPgrp(w.pgid, "SIGTERM");
  }
}

/* ---------------- Turn-stall watchdog (M5) ---------------- */

const DEFAULT_TURN_STALL_MS = 30 * 60 * 1000; // 30 minutes
const TURN_STALL_CHECK_MS = 60 * 1000; // 1 minute

let stallInterval: NodeJS.Timeout | undefined;

/**
 * The shape of a stalled-worker check input. Decoupled from LiveWorker so
 * the inner loop is testable without populating the live map.
 */
export interface StallCandidate {
  agentName: string;
  turnId: string;
  pgid: number;
  status: "idle" | "working";
  lastBlockStop: number;
}

/**
 * Pure stall-detector. Returns the list of worker names that exceeded the
 * threshold and invokes `kill` on each (test injects a spy). Mutates each
 * candidate's `lastBlockStop` to `now` so a follow-up tick before the
 * worker's `exit` event doesn't re-fire.
 */
export function checkStalledWorkers(
  workers: Iterable<StallCandidate>,
  now: number,
  threshold: number,
  kill: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void,
): string[] {
  const killed: string[] = [];
  for (const w of workers) {
    if (w.status !== "working") continue;
    const since = now - w.lastBlockStop;
    if (since > threshold) {
      logger.log("warn", "worker.turn.stalled", {
        agent: w.agentName,
        turnId: w.turnId,
        stalledMs: since,
        thresholdMs: threshold,
      });
      kill(w.pgid, "SIGTERM");
      setTimeout(() => kill(w.pgid, "SIGKILL"), 2_000).unref();
      w.lastBlockStop = now;
      killed.push(w.agentName);
    }
  }
  return killed;
}

/**
 * Start the per-turn stall watchdog. Periodically scans live workers; if a
 * worker has been in `working` status for longer than the stall threshold
 * without any block-stop, pgrp-SIGTERM it. Honest runaway loops (no model
 * output for half an hour) get reaped before they cost real money or
 * burn a day's worth of background CPU. Threshold overridable via
 * `FRIDAY_TURN_STALL_MS` env (milliseconds).
 */
export function startTurnStallWatchdog(): void {
  if (stallInterval) return;
  const threshold = Number(
    process.env.FRIDAY_TURN_STALL_MS ?? DEFAULT_TURN_STALL_MS,
  );
  stallInterval = setInterval(() => {
    checkStalledWorkers(live.values(), Date.now(), threshold, killPgrp);
  }, TURN_STALL_CHECK_MS);
  stallInterval.unref();
}

export function stopTurnStallWatchdog(): void {
  if (stallInterval) {
    clearInterval(stallInterval);
    stallInterval = undefined;
  }
}

/**
 * Send a `mail-wakeup` IPC to a live worker so it drains its inbox without
 * waiting for the 60s idle timeout. Returns true if delivered, false if the
 * agent isn't currently live.
 */
export function wakeAgent(agentName: string): boolean {
  const w = live.get(agentName);
  if (!w) return false;
  send(w.child, { type: "mail-wakeup" });
  return true;
}

/**
 * Send a `mail-wakeup-critical` IPC. The worker breaks its current SDK
 * iterator at the next assistant-message boundary (FIX_FORWARD 2.4) and
 * drains the inbox — the critical mail row is at minimum the first to be
 * included in the resulting mail prompt.
 */
export function wakeAgentCritical(agentName: string): boolean {
  const w = live.get(agentName);
  if (!w) return false;
  send(w.child, { type: "mail-wakeup-critical" });
  return true;
}

export function isAgentLive(agentName: string): boolean {
  return live.has(agentName);
}

export function liveAgentNames(): string[] {
  return [...live.keys()];
}

/**
 * Watchdog-only readonly peek at a live worker. Returns a frozen view of the
 * fields the watchdog needs; never returns the LiveWorker itself, so callers
 * can't mutate the live map by accident.
 */
export function peekLiveWorker(agentName: string): {
  status: "idle" | "working";
  lastHeartbeat: number;
  agentType: AgentType;
  turnId: string;
} | null {
  const w = live.get(agentName);
  if (!w) return null;
  return {
    status: w.status,
    lastHeartbeat: w.lastHeartbeat,
    agentType: w.agentType,
    turnId: w.turnId,
  };
}

export function handleEvent(w: LiveWorker, e: WorkerEvent): void {
  w.lastHeartbeat = Date.now();
  switch (e.type) {
    case "session-update":
      w.sessionId = e.sessionId;
      registry.setSession(w.agentName, e.sessionId);
      // No live JSONL tail-watcher: blocks are persisted directly via the
      // worker → daemon IPC pipeline (FIX_FORWARD 1.2). JSONL is reconciled
      // only at boot (FIX_FORWARD 1.3).
      break;
    case "block-start": {
      handleBlockStart(w, e);
      break;
    }
    case "block-delta": {
      handleBlockDelta(w, e);
      break;
    }
    case "block-stop": {
      // M5: block-stop is the canonical "model made progress" signal for
      // the turn-stall watchdog. Heartbeats don't count — a hung SDK still
      // emits them, but no block ever lands.
      w.lastBlockStop = Date.now();
      handleBlockStop(w, e);
      break;
    }
    case "error":
      w.lastExitStatus = w.abortRequested ? "aborted" : "error";
      eventBus.publish({
        v: 1,
        type: "error",
        turn_id: w.turnId,
        agent: w.agentName,
        code: w.abortRequested ? "aborted" : "worker_error",
        message: e.message,
        recoverable: e.recoverable,
      });
      break;
    case "status-change":
      w.status = e.status;
      eventBus.publish({
        v: 1,
        type: "agent_status",
        agent: w.agentName,
        status: e.status === "working" ? "working" : "idle",
        since: Date.now(),
      });
      break;
    case "turn-complete": {
      const durationMs = Date.now() - w.turnStart;
      eventBus.publish({
        v: 1,
        type: "turn_done",
        turn_id: w.turnId,
        agent: w.agentName,
        status: w.abortRequested ? "aborted" : "complete",
        usage: e.usage
          ? {
              input_tokens: e.usage.input_tokens,
              output_tokens: e.usage.output_tokens,
              cache_creation_tokens: e.usage.cache_creation_tokens,
              cache_read_tokens: e.usage.cache_read_tokens,
              cost_usd: e.usage.cost_usd,
            }
          : undefined,
      });
      if (e.usage && (w.sessionId || e.sessionId)) {
        try {
          insertUsage({
            timestamp: new Date().toISOString(),
            sessionId: w.sessionId ?? e.sessionId,
            agentName: w.agentName,
            agentType: w.agentType,
            model: w.model,
            costUsd: e.usage.cost_usd,
            inputTokens: e.usage.input_tokens,
            outputTokens: e.usage.output_tokens,
            cacheCreationTokens: e.usage.cache_creation_tokens,
            cacheReadTokens: e.usage.cache_read_tokens,
            durationMs,
          });
        } catch (err) {
          logger.log("warn", "usage.insert.error", {
            agent: w.agentName,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // The in-flight registry holds per-turn block accumulators (FIX_FORWARD
      // 1.4). Drop the entry once the turn completes; canonical block content
      // already lives in the `blocks` table.
      liveTurns.dropTurn(w.turnId);
      // Long-lived worker: flush queued prompt if any. Don't send `stop` — the
      // worker manages its own lifecycle.
      w.status = "idle";
      w.completedAtLeastOnce = true;
      w.lastExitStatus = w.abortRequested ? "aborted" : "complete";
      registry.setStatus(w.agentName, "idle");
      const next = w.nextPrompts.shift();
      if (next) sendPrompt(w, next);
      break;
    }
    case "heartbeat":
      // No SSE wire event yet; lastHeartbeat update at top of handler is
      // enough for the Phase 6 watchdog.
      break;
    case "ready":
      // Already handled by the once() listener that sends `start`.
      break;
  }
}

function send(child: ChildProcess, cmd: WorkerCommand): void {
  if (child.send) child.send(cmd);
}

/* ---------------- Agent message notification (FIX_FORWARD 2.8) ---------------- */

/**
 * Emit an `agent_message` SSE event when a text block_complete lands with
 * role=assistant or role=user+source=mail. Replaces the old `chat_reply`
 * notification surface (removed in 2.1) and is now sourced exclusively
 * from real block commits.
 *
 * Tool / thinking blocks don't fire this — those are mechanism, not
 * user-visible chat content.
 */
function maybeEmitAgentMessage(opts: {
  agent: string;
  turnId: string;
  blockId: string;
  role: string;
  kind: BlockKind | string;
  source: BlockSource;
  status: string;
  contentJson: string;
}): void {
  if (opts.kind !== "text") return;
  if (opts.status !== "complete") return;
  const isAssistant = opts.role === "assistant";
  const isMail = opts.role === "user" && opts.source === "mail";
  if (!isAssistant && !isMail) return;
  let text = "";
  try {
    const parsed = JSON.parse(opts.contentJson) as { text?: string };
    if (typeof parsed.text === "string") text = parsed.text;
  } catch {
    // Malformed content_json — leave preview undefined.
  }
  const trimmed = text.trim();
  const preview =
    trimmed.length === 0
      ? undefined
      : trimmed.length > 240
        ? trimmed.slice(0, 240).trim() + "…"
        : trimmed;
  eventBus.publish({
    v: 1,
    type: "agent_message",
    agent: opts.agent,
    turn_id: opts.turnId,
    block_id: opts.blockId,
    kind: "block_complete",
    preview,
  });
}

/* ---------------- DB-before-SSE atomic helper (FIX_FORWARD 1.10) ---------------- */
// Pins ADR-004 at block granularity: every SSE event tied to a `blocks` row
// is preceded by a synchronous DB write that stamps the row's
// `last_event_seq` with the same value the SSE event will carry. Because
// Node is single-threaded and `dbWrite` is synchronous (better-sqlite3) and
// no other eventBus.publish() calls run between `currentSeq() + 1` and our
// `eventBus.publish(...)`, the captured `seq` is exactly what publish()
// assigns. If a future refactor were to violate that, the assertion below
// flags the skew so it's caught before reaching SSE consumers.

type PublishableEvent = Parameters<typeof eventBus.publish>[0];

function writeAndPublish<E extends PublishableEvent>(
  event: E,
  dbWrite: (seq: number) => void,
): { seq: number } {
  const seq = eventBus.currentSeq() + 1;
  dbWrite(seq);
  const full = eventBus.publish(event);
  if (full.seq !== seq) {
    logger.log("warn", "block.seq-skew", {
      expected: seq,
      actual: full.seq,
      type: full.type,
    });
  }
  return { seq: full.seq };
}

/* ---------------- Block IPC handlers (FIX_FORWARD 1.2) ---------------- */

/**
 * INSERT a blocks row (status='streaming'), then publish the SSE block_start.
 * The DB write strictly precedes the SSE emit so any client that fetches the
 * canonical block on `block_start` sees a row whose `last_event_seq` already
 * matches the event seq.
 */
function handleBlockStart(
  w: LiveWorker,
  e: {
    clientBlockId: string;
    kind: BlockKind;
    blockIndex: number;
    messageId?: string;
    tool?: { id: string; name: string };
  },
): void {
  const sessionId = w.sessionId ?? "__pending__";
  const blockId = randomUUID();
  const ts = Date.now();
  // Tool_result arrives in a `user` SDK message but its block is the agent's
  // tool output, so we treat it as role='assistant' — chat persistence keeps
  // tool calls and their results grouped under the assistant's turn.
  const role = "assistant";
  const source: BlockSource = null;

  let insertOk = true;
  let assignedSeq = 0;
  try {
    const result = writeAndPublish(
      {
        v: 1,
        type: "block_start",
        turn_id: w.turnId,
        agent: w.agentName,
        block_id: blockId,
        message_id: e.messageId ?? null,
        block_index: e.blockIndex,
        role,
        kind: e.kind,
        source,
        tool: e.tool,
        ts,
      },
      (seq) => {
        insertBlock({
          blockId,
          turnId: w.turnId,
          agentName: w.agentName,
          sessionId,
          messageId: e.messageId ?? null,
          blockIndex: e.blockIndex,
          role,
          kind: e.kind,
          source,
          contentJson: "",
          status: "streaming",
          ts,
          lastEventSeq: seq,
        });
      },
    );
    assignedSeq = result.seq;
  } catch (err) {
    insertOk = false;
    logger.log("warn", "blocks.insert.error", {
      agent: w.agentName,
      blockId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (!insertOk) return;

  liveTurns.startBlock({
    turnId: w.turnId,
    agentName: w.agentName,
    sessionId,
    clientBlockId: e.clientBlockId,
    blockId,
    messageId: e.messageId ?? null,
    blockIndex: e.blockIndex,
    role,
    kind: e.kind,
    source,
    tool: e.tool,
    ts,
    seq: assignedSeq,
  });
}

function handleBlockDelta(
  w: LiveWorker,
  e: { clientBlockId: string; delta: { text?: string; partial_json?: string } },
): void {
  const nextSeq = eventBus.currentSeq() + 1;
  const live = liveTurns.appendDelta(
    w.turnId,
    e.clientBlockId,
    e.delta,
    nextSeq,
  );
  if (!live) return;
  // Persist the accumulated text + bump `last_event_seq` so a mid-turn
  // reload picks up the partial content from /api/agents/:name/blocks
  // and skips the replayed deltas via the per-agent SSE cursor. Without
  // this the row stays at `content_json=""` until block_complete, the
  // dashboard's parseBlocks renders an empty bubble, the resumed SSE
  // deltas append from "" — and if the ring buffer evicted the early
  // deltas, the user sees only the late half. We only write text
  // accumulation here; tool_use blocks accumulate `partial_json` and
  // don't render incrementally on the client, so their canonical
  // content arrives via block_complete as before.
  if (
    typeof e.delta.text === "string" &&
    (live.kind === "text" || live.kind === "thinking")
  ) {
    try {
      updateBlock(live.blockId, {
        contentJson: JSON.stringify({ text: live.text }),
        lastEventSeq: nextSeq,
      });
    } catch (err) {
      // A DB write failure here doesn't break the live stream — the
      // SSE event still publishes below. Mid-stream reload would
      // fall back to empty content (the prior failure mode).
      logger.log("warn", "blocks.delta.update.fail", {
        agent: w.agentName,
        blockId: live.blockId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  eventBus.publish({
    v: 1,
    type: "block_delta",
    turn_id: w.turnId,
    agent: w.agentName,
    block_id: live.blockId,
    delta: e.delta,
  });
}

function handleBlockStop(
  w: LiveWorker,
  e: {
    clientBlockId: string;
    contentJson: string;
    status: "complete" | "aborted" | "error";
  },
): void {
  const ts = Date.now();
  // Peek at the upcoming seq so live-turns sees the same value we'll stamp
  // onto the row + SSE event. `writeAndPublish` validates this binding
  // holds at publish time.
  const peekSeq = eventBus.currentSeq() + 1;
  const live = liveTurns.finishBlock(w.turnId, e.clientBlockId, peekSeq);
  if (!live) return;
  writeAndPublish(
    {
      v: 1,
      type: "block_complete",
      turn_id: w.turnId,
      agent: w.agentName,
      block_id: live.blockId,
      message_id: live.messageId,
      block_index: live.blockIndex,
      role: live.role,
      kind: live.kind,
      source: live.source,
      content_json: e.contentJson,
      status: e.status,
      ts,
    },
    (seq) => {
      try {
        updateBlock(live.blockId, {
          contentJson: e.contentJson,
          status: e.status,
          ts,
          lastEventSeq: seq,
        });
      } catch (err) {
        logger.log("warn", "blocks.update.error", {
          agent: w.agentName,
          blockId: live.blockId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
  // FIX_FORWARD 2.8: badge the agent when the block is user-visible chat
  // content. Tool/thinking blocks don't fire this.
  maybeEmitAgentMessage({
    agent: w.agentName,
    turnId: w.turnId,
    blockId: live.blockId,
    role: live.role,
    kind: live.kind,
    source: live.source,
    status: e.status,
    contentJson: e.contentJson,
  });
}

/* ---------------- User-typed block insertion (FIX_FORWARD 1.2) ---------------- */

export interface RecordUserBlockInput {
  turnId: string;
  agentName: string;
  /** Falls back to '__pending__' if the agent doesn't yet have a session. */
  sessionId?: string;
  text: string;
  source: "user_chat" | "mail" | "queue_inject";
  /** Mail-derived blocks carry sender metadata inside content_json. */
  fromAgent?: string;
  /** Mail-derived blocks: extra MailRow metadata serialized into
   *  content_json so the dashboard can render rich detail (id, subject,
   *  type, priority, threadId, ts) on the collapsed `MailBlock` without
   *  a separate fetch. */
  mailMeta?: {
    id: number;
    subject: string | null;
    type: string;
    priority: string;
    threadId: string | null;
    ts: number;
  };
}

/**
 * Persist a user-role block ahead of (or alongside) a dispatched turn. The
 * row lands with `status='complete'` immediately — there's no streaming
 * lifecycle for user-typed or mail-derived content.
 */
export function recordUserBlock(input: RecordUserBlockInput): {
  blockId: string;
  seq: number;
} {
  const blockId = randomUUID();
  const ts = Date.now();
  const content =
    input.source === "mail" && input.fromAgent
      ? {
          text: input.text,
          from_agent: input.fromAgent,
          ...(input.mailMeta
            ? {
                mail_id: input.mailMeta.id,
                mail_subject: input.mailMeta.subject,
                mail_type: input.mailMeta.type,
                mail_priority: input.mailMeta.priority,
                mail_thread_id: input.mailMeta.threadId,
                mail_ts: input.mailMeta.ts,
              }
            : {}),
        }
      : { text: input.text };
  const contentJson = JSON.stringify(content);
  // The `user_chat` path has the dashboard's optimistic bubble already
  // rendered before POST /api/chat/turn returns. Emitting the canonical
  // `block_complete` SSE frame here races the POST response, and when the
  // SSE wins, the dashboard ends up with two user-role bubbles for the
  // same turn (one re-keyed by `confirmPending`, one freshly-pushed by
  // `handleBlockComplete`). Skip the SSE publish for `user_chat`; the
  // block row is still persisted so reloads via `/api/agents/:name/blocks`
  // return the message. Mail / scheduled / queue-injected user blocks
  // have no upstream optimistic bubble, so their SSE frames still emit.
  let seq: number;
  if (input.source === "user_chat") {
    seq = 0; // not in the event bus; not consumed by callers either
    insertBlock({
      blockId,
      turnId: input.turnId,
      agentName: input.agentName,
      sessionId: input.sessionId ?? "__pending__",
      messageId: null,
      blockIndex: 0,
      role: "user",
      kind: "text",
      source: input.source,
      contentJson,
      status: "complete",
      ts,
      lastEventSeq: seq,
    });
  } else {
    seq = writeAndPublish(
      {
        v: 1,
        type: "block_complete",
        turn_id: input.turnId,
        agent: input.agentName,
        block_id: blockId,
        message_id: null,
        block_index: 0,
        role: "user",
        kind: "text",
        source: input.source,
        content_json: contentJson,
        status: "complete",
        ts,
      },
      (assignedSeq) => {
        insertBlock({
          blockId,
          turnId: input.turnId,
          agentName: input.agentName,
          sessionId: input.sessionId ?? "__pending__",
          messageId: null,
          blockIndex: 0,
          role: "user",
          kind: "text",
          source: input.source,
          contentJson,
          status: "complete",
          ts,
          lastEventSeq: assignedSeq,
        });
      },
    ).seq;
  }
  // FIX_FORWARD 2.8: mail-derived user blocks badge the recipient agent
  // (a piece of user-visible content just landed in their chat).
  // user_chat / queue_inject blocks are typed by the user themselves and
  // need no notification.
  maybeEmitAgentMessage({
    agent: input.agentName,
    turnId: input.turnId,
    blockId,
    role: "user",
    kind: "text",
    source: input.source,
    status: "complete",
    contentJson,
  });
  return { blockId, seq };
}
