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
  deleteBlockById,
  insertBlock,
  insertUsage,
  updateBlock,
  type BlockSource,
} from "@friday/shared/services";
import { eventBus } from "../events/bus.js";
import { logger } from "../log.js";
import {
  type ArchiveReason,
  closeTicketForArchive,
} from "../services/ticket-close.js";
import * as registry from "./registry.js";
import * as liveTurns from "./live-turns.js";
import { appContextForAgent } from "../apps/installer.js";
import { recoverFromJsonl } from "./jsonl-recovery.js";
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
  /** Stop force-kill safety net (FRI-12). When `abortTurn` fires, we
   *  schedule a 2s deadline; if the worker doesn't acknowledge the abort
   *  by then, `forceKillStuckWorker` finalizes the turn and SIGTERMs the
   *  process group. The deadline is cleared on any worker response
   *  (turn-complete, error, status-change) so a worker that aborted
   *  cleanly doesn't get killed on the way out. */
  abortDeadline?: NodeJS.Timeout;
  /** Set when `forceKillStuckWorker` has already finalized this turn and
   *  killed the worker. Subsequent error/turn-complete IPC messages from
   *  the dying worker are ignored so we don't double-publish turn_done. */
  forceKilled?: boolean;
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
  /** Present only when the caller recorded the user block as `status='queued'`
   *  (the worker was already busy at POST time). Propagates to the queued
   *  `WorkerPromptCommand` so `sendPrompt` knows to re-stamp the row on
   *  dispatch. Omitted for immediate dispatch (`recordUserBlock` already
   *  wrote `status='complete'`). */
  userBlockId?: string;
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

  // FRI-78: auto-populate per-app context for agents owned by an
  // installed app. Centralized here so every dispatch path (api, mail,
  // schedule, watchdog refork) inherits the wiring; callers don't need
  // to remember to set it.
  if (!input.options.appContext) {
    const ctx = appContextForAgent(input.agentName);
    if (ctx) {
      input.options = { ...input.options, appContext: ctx };
    }
  }

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
    // F4-A: any in-flight blocks for the current turn never got their own
    // `block-stop` because the worker died without going through
    // `runQuery`'s try/catch. Common path: stall watchdog SIGTERM at 30
    // min — the kernel reaps the process before any user-space cleanup
    // runs, so no `error` IPC event, no DB transition, and the
    // dashboard's tool/thinking bubbles stay `running` forever. Walk the
    // live registry here and finalize anything still streaming as
    // `status='error'`. The normal IPC-driven `handleBlockStop` path
    // would have already emptied the map for clean exits; this is
    // strictly the SIGTERM / SIGKILL / OOM / crash safety net.
    finalizeStreamingBlocks(w, "error");
    // If the worker died mid-turn the in-flight registry entry would leak —
    // drop it here so the daemon doesn't hold accumulator state for a turn
    // that can no longer make progress.
    liveTurns.dropTurn(w.turnId);
    live.delete(input.agentName);
    // F1-A: preserve terminal statuses. If the worker just exited because
    // `archiveAgent` asked it to stop, the row is already "archived" — we
    // must not overwrite it back to "idle" or the workspace-cleanup half
    // of an archive call would race the wrong status. Same for "error":
    // a crash-marked row stays crashed.
    const cur = registry.getAgent(input.agentName);
    if (cur && cur.status !== "archived" && cur.status !== "error") {
      registry.setStatus(input.agentName, "idle");
    }
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

  // Mirror sendPrompt's queued-block bookkeeping for the fork-fresh path:
  // when a queued user block triggers a worker spawn (rehydration or POST
  // against an offline worker), the block is sitting at status='queued'
  // with the POST-time ts. Re-stamp it now so the dashboard's pinned
  // bubble unpins as the worker comes up.
  restampQueuedUserBlock(
    input.agentName,
    input.options.turnId,
    input.userBlockId,
  );
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
    attachments: input.options.attachments,
    turnId: input.options.turnId,
    resumeSessionId:
      input.options.resumeSessionId ?? existing.sessionId ?? undefined,
    allowedToolsOverride: input.options.allowedToolsOverride,
    userBlockId: input.userBlockId,
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
      // FRI-72: capture daemon's view of why this turn queued. If
      // `existingStatus` is "working" but the prior turn-complete never
      // landed, this is the canonical fingerprint of the stuck-status
      // bug (Seth's "queued for a fraction of a second" symptom).
      existingStatus: existing.status,
      existingTurnId: existing.turnId,
    });
  }
}

/**
 * Flip a queued user block to `status='complete'` with a fresh `ts` and
 * announce it on SSE so the dashboard unpins the bubble and re-sorts it
 * inline. ADR-004 ordering: writeAndPublish stamps the row's
 * last_event_seq with the same value the SSE event will carry.
 *
 * Called from both `sendPrompt` (queue-drain → existing live worker) and
 * `spawnTurn` (rehydrated queue or POST against an offline worker forces
 * a fresh fork). Safe to call with `undefined` blockId — no-op.
 */
function restampQueuedUserBlock(
  agentName: string,
  turnId: string,
  userBlockId: string | undefined,
): void {
  if (!userBlockId) return;
  const dispatchTs = Date.now();
  try {
    writeAndPublish(
      {
        v: 1,
        type: "block_meta_update",
        turn_id: turnId,
        agent: agentName,
        block_id: userBlockId,
        status: "complete",
        ts: dispatchTs,
      },
      (assignedSeq) => {
        updateBlock(userBlockId, {
          status: "complete",
          ts: dispatchTs,
          lastEventSeq: assignedSeq,
        });
      },
    );
  } catch (err) {
    logger.log("warn", "queued-block.meta-update.error", {
      agent: agentName,
      turnId,
      blockId: userBlockId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * FRI-72 instrumentation: every `w.status` transition flows through here so
 * the daemon log captures who changed it and why. The "queued for a fraction"
 * symptom (daemon thinks the worker is still working long after its last
 * turn) points at a missing or out-of-order status update; this trace makes
 * the misordering visible without changing behavior.
 */
function setWorkerStatus(
  w: LiveWorker,
  next: "idle" | "working",
  source: string,
): void {
  if (w.status !== next) {
    logger.log("info", "worker.status.transition", {
      agent: w.agentName,
      prev: w.status,
      next,
      source,
      turnId: w.turnId,
    });
  }
  w.status = next;
}

function sendPrompt(w: LiveWorker, p: WorkerPromptCommand): void {
  restampQueuedUserBlock(w.agentName, p.turnId, p.userBlockId);
  w.turnId = p.turnId;
  w.turnStart = Date.now();
  w.abortRequested = false;
  setWorkerStatus(w, "working", "sendPrompt");
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

/**
 * Test seams: insert / remove a fake LiveWorker without going through the
 * spawn pipeline. Used by `lifecycle-stop-forcekill.test.ts` to drive
 * `abortTurn` against a synthetic worker. Not for production use; the
 * inserted entry has no real child process and skipping the spawn path
 * means events the spawn handler would normally publish won't fire.
 */
export function __putLiveWorkerForTest(name: string, w: LiveWorker): void {
  live.set(name, w);
}
export function __deleteLiveWorkerForTest(name: string): void {
  live.delete(name);
}

export function abortTurn(agentName: string): boolean {
  const w = live.get(agentName);
  if (!w) return false;
  w.abortRequested = true;
  // FRI-72 instrumentation: pair this with `worker.ipc.recv` so the log
  // shows whether the worker acknowledged the abort (turn-complete /
  // status-change / error) before forceKillStuckWorker's 2s deadline.
  logger.log("info", "worker.ipc.send", {
    agent: w.agentName,
    type: "abort",
    turnId: w.turnId,
    workerStatus: w.status,
  });
  send(w.child, { type: "abort" });
  // FRI-12 safety net: if the worker is wedged inside an SDK call (the
  // 529 lockup), the abort IPC is silently ignored — the AbortController's
  // `abort()` only fires inside the worker process, and a stuck SDK loop
  // never returns control. Without this deadline, the dashboard's bubble
  // would freeze in 'stopping' forever waiting for a turn_done that's
  // never coming. Two seconds is generous for a healthy worker (an
  // honest abort lands in tens of milliseconds) and short enough that
  // the user's Stop click feels responsive.
  if (w.abortDeadline) clearTimeout(w.abortDeadline);
  w.abortDeadline = setTimeout(() => forceKillStuckWorker(w), 2_000);
  w.abortDeadline.unref();
  return true;
}

function clearAbortDeadline(w: LiveWorker): void {
  if (w.abortDeadline) {
    clearTimeout(w.abortDeadline);
    w.abortDeadline = undefined;
  }
}

/**
 * The worker didn't respond to abort within the deadline — finalize the
 * turn ourselves and tear down the process. The next user message will
 * dispatch a fresh fork via the normal `dispatchTurn → spawnTurn` path.
 *
 * Idempotent: re-entry is gated by `w.forceKilled`. The dying worker may
 * still emit a final IPC message before the kernel reaps it; the error
 * and turn-complete handlers honor `forceKilled` and bail.
 */
function forceKillStuckWorker(w: LiveWorker): void {
  if (w.forceKilled) return;
  if (!live.has(w.agentName)) return;
  w.forceKilled = true;
  w.abortDeadline = undefined;

  logger.log("warn", "worker.abort.force-kill", {
    agent: w.agentName,
    turnId: w.turnId,
  });

  insertErrorBlock(w, {
    code: "stopped_forced",
    headline: "Stopped — worker did not respond to abort, restarted",
    rawMessage:
      "Stop deadline exceeded: the worker process ignored the abort signal " +
      "for 2s. The agent has been killed; the next message will spawn a " +
      "fresh worker.",
  });
  finalizeStreamingBlocks(w, "aborted");
  // Emit the in-band TurnErrorEvent so any consumers still listening for
  // it know a force-kill happened (vs. a clean abort).
  eventBus.publish({
    v: 1,
    type: "error",
    turn_id: w.turnId,
    agent: w.agentName,
    code: "stopped_forced",
    message: "Stop forced — worker unresponsive",
    recoverable: true,
  });
  eventBus.publish({
    v: 1,
    type: "turn_done",
    turn_id: w.turnId,
    agent: w.agentName,
    status: "aborted",
  });
  // Drop the live-turn entry now so the upcoming child.exit handler's
  // safety-net `finalizeStreamingBlocks` is a no-op (would otherwise
  // double-publish block_complete for the same blocks).
  liveTurns.dropTurn(w.turnId);
  w.lastExitStatus = "aborted";
  setWorkerStatus(w, "idle", "forceKillStuckWorker");
  registry.setStatus(w.agentName, "idle");

  // Tear down the process group. We've already waited 2s for the worker
  // to honor the abort IPC, so skip the graceful 'stop' command and go
  // straight to SIGTERM. SIGKILL fallback at +1.5s catches anything that
  // ignored SIGTERM. The child.on("exit") handler removes the agent from
  // `live` and emits agent_lifecycle/complete; the next dispatchTurn
  // forks fresh.
  killPgrp(w.pgid, "SIGTERM");
  setTimeout(() => {
    if (live.has(w.agentName)) killPgrp(w.pgid, "SIGKILL");
  }, 1_500).unref();
}

/**
 * Find the live agent whose current turn matches `turnId`. Used by the
 * abort endpoint so a Stop click on agent A doesn't tear down B and C
 * just because all three happened to be mid-turn. Returns null when the
 * turn has already completed or never started — the abort caller should
 * surface that as `aborted: false`.
 */
export function findAgentByTurnId(turnId: string): string | null {
  for (const [name, w] of live) {
    if (w.turnId === turnId) return name;
  }
  return null;
}

/**
 * Tear down a live worker and clean its registry row. FIX_FORWARD 4.1: the
 * returned promise resolves only after the child process has actually
 * exited (or after a 5s SIGKILL fallback fires). The watchdog's refork
 * path awaits this so it can't race the next fork against the dying
 * worker's lingering IPC traffic.
 *
 * F4-B: the resolved value is the captured `nextPrompts` queue. Watchdog
 * refork redispatches these so user prompts that arrived while the old
 * worker was hung aren't dropped on archive (FRI-4). Fire-and-forget
 * callers (REST archive endpoints, system commands) can ignore both the
 * promise and its value — the side-effects (registry archive,
 * agent_lifecycle event, live-map remove) happen synchronously up front.
 *
 * `opts.reason` is required: it both documents intent (was this a successful
 * completion, an abandonment, a failure, or an internal refork?) and drives
 * the linked-ticket close behavior. See `services/ticket-close.ts` for the
 * mapping. Watchdog refork must pass `"refork"` or the closer will move the
 * ticket to a terminal status on every transient stall.
 */
export function archiveAgent(
  agentName: string,
  opts: { reason: ArchiveReason },
): Promise<WorkerPromptCommand[]> {
  const w = live.get(agentName);
  // Capture queued prompts before we drop the worker from the live map.
  // The watchdog's refork path uses these to redispatch on the fresh
  // worker; ad-hoc archive calls just ignore the return value.
  const drainedPrompts: WorkerPromptCommand[] = w ? [...w.nextPrompts] : [];
  // Capture ticketId BEFORE registry.archiveAgent — defensive against a
  // future refactor that nulls the row's fields on archive. The closer
  // reads from this captured value, not from the registry.
  const agentRow = registry.getAgent(agentName);
  const ticketId =
    agentRow && "ticketId" in agentRow ? agentRow.ticketId ?? null : null;
  // Synchronous side-effects: drop from the live map so subsequent
  // dispatchTurn / wakeAgent / etc. see a clean slate immediately, even
  // before the child has fully exited.
  if (w) live.delete(agentName);
  registry.archiveAgent(agentName);
  eventBus.publish({
    v: 1,
    type: "agent_lifecycle",
    agent: agentName,
    agentType: w?.agentType ?? "orchestrator",
    event: "archive",
  });
  // Fire-and-forget: the closer owns its error handling and must never
  // bubble back into the worker-teardown path.
  void closeTicketForArchive({
    ticketId,
    reason: opts.reason,
    agentName,
  });
  if (!w) return Promise.resolve(drainedPrompts);

  // Ask the worker to stop gracefully, then wait for the actual exit
  // event. SIGTERM-on-pgrp backstop at 5s catches descendants the worker
  // leaked; SIGKILL-on-pgrp at 7s is the hard floor.
  send(w.child, { type: "stop" });
  if (w.child.exitCode !== null || w.child.killed) {
    // Child is already gone, but descendants may still be running.
    killPgrp(w.pgid, "SIGTERM");
    setTimeout(() => killPgrp(w.pgid, "SIGKILL"), 2_000).unref();
    return Promise.resolve(drainedPrompts);
  }

  return new Promise<WorkerPromptCommand[]>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(drainedPrompts);
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
  const terminated: string[] = [];
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
      terminated.push(w.agentName);
    }
  }
  return terminated;
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

/**
 * Remove a queued prompt (one that hasn't yet been dispatched to the worker)
 * matching `turnId` from the live worker's `nextPrompts`. Returns the
 * removed `WorkerPromptCommand` so callers can inspect the prompt text
 * (used by the DELETE cancel endpoint to return the recovered text to the
 * dashboard). Returns null when no live worker for this agent, or when no
 * queued entry matches.
 */
export function removeQueuedPrompt(
  agentName: string,
  turnId: string,
): WorkerPromptCommand | null {
  const w = live.get(agentName);
  if (!w) return null;
  const idx = w.nextPrompts.findIndex((p) => p.turnId === turnId);
  if (idx < 0) return null;
  const [removed] = w.nextPrompts.splice(idx, 1);
  return removed;
}

export function handleEvent(w: LiveWorker, e: WorkerEvent): void {
  // FRI-72 instrumentation: log lifecycle-significant IPC arrivals.
  // Heartbeats and per-block frames are skipped — too chatty and the
  // canonical block table already records that pipeline. The interesting
  // diagnostics are turn boundaries, status changes, errors, and ready —
  // exactly the events whose absence (or out-of-order arrival) causes the
  // stuck-status family of bugs we're tracking.
  if (
    e.type === "turn-complete" ||
    e.type === "status-change" ||
    e.type === "error" ||
    e.type === "ready"
  ) {
    logger.log("info", "worker.ipc.recv", {
      agent: w.agentName,
      type: e.type,
      turnId: w.turnId,
      workerStatus: w.status,
      msSinceTurnStart: w.turnStart ? Date.now() - w.turnStart : null,
      msSinceLastHeartbeat: Date.now() - w.lastHeartbeat,
    });
  }
  w.lastHeartbeat = Date.now();
  switch (e.type) {
    case "session-update":
      w.sessionId = e.sessionId;
      registry.setSession(w.agentName, e.sessionId);
      // No live JSONL tail-watcher: blocks are persisted directly via the
      // worker → daemon IPC pipeline (FIX_FORWARD 1.2). JSONL is reconciled
      // at boot (FIX_FORWARD 1.3) and after every turn-complete on this
      // worker (catches mid-turn iterator-break drift; see the
      // turn-complete handler below).
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
    case "block-cancel": {
      // FRI-78 follow-up: the SDK started a content block (block-start
      // already fired and the row exists at status='streaming') and the
      // worker exited the for-await before any deltas accumulated. Drop
      // the row and tell live clients to remove the bubble.
      handleBlockCancel(w, e);
      break;
    }
    case "error": {
      // FRI-12: a worker response — even an error — means the abort was
      // honored; cancel the force-kill deadline so we don't redundantly
      // kill an already-cooperative worker.
      clearAbortDeadline(w);
      // forceKillStuckWorker has already finalized this turn. The worker
      // may still emit a final IPC message before the kernel reaps it;
      // ignore it so we don't double-publish turn_done.
      if (w.forceKilled) break;
      const wasAbort = w.abortRequested;
      w.lastExitStatus = wasAbort ? "aborted" : "error";
      // Materialize the failure as a chat-visible error block so the user
      // sees what happened (was previously silent — the worker emitted an
      // IPC error but no DB row was written, leaving the bubble in
      // "running" until reconcile-on-restart). Skipped for plain aborts:
      // the bubble is already visible via the user's Stop click and the
      // assistant text bubble flips to "aborted" via finishTurn below.
      if (!wasAbort) {
        insertErrorBlock(w, {
          code: e.code ?? "worker_error",
          headline: e.headline ?? e.message,
          httpStatus: e.httpStatus,
          retryAfterSeconds: e.retryAfterSeconds,
          requestId: e.requestId,
          rawMessage: e.rawMessage ?? e.message,
        });
      }
      // Close any blocks left at status='streaming' so their dashboard
      // bubbles transition off "running". finalizeStreamingBlocks is
      // idempotent — safe to call even when the inflight set is empty.
      finalizeStreamingBlocks(w, wasAbort ? "aborted" : "error");
      // Publish the canonical TurnErrorEvent (kept for any consumer that
      // listens for it) BEFORE the synthesized turn_done — clients route
      // both, but ordering means the error metadata is in hand by the time
      // the turn flips terminal.
      eventBus.publish({
        v: 1,
        type: "error",
        turn_id: w.turnId,
        agent: w.agentName,
        code: wasAbort ? "aborted" : (e.code ?? "worker_error"),
        message: e.message,
        recoverable: e.recoverable,
      });
      // The missing event that caused the wedge: without turn_done, the
      // dashboard's inflightTurnId stays pinned to this turn forever.
      eventBus.publish({
        v: 1,
        type: "turn_done",
        turn_id: w.turnId,
        agent: w.agentName,
        status: wasAbort ? "aborted" : "error",
      });
      // Clean up live state the way turn-complete would. The worker
      // process keeps running (long-lived agents stay alive across
      // failures); reset its bookkeeping so the next prompt dispatches
      // cleanly.
      liveTurns.dropTurn(w.turnId);
      setWorkerStatus(w, "idle", "handleEvent.error");
      w.completedAtLeastOnce = true;
      registry.setStatus(w.agentName, "idle");
      eventBus.publish({
        v: 1,
        type: "agent_status",
        agent: w.agentName,
        status: "idle",
        since: Date.now(),
      });
      const next = w.nextPrompts.shift();
      if (next) sendPrompt(w, next);
      break;
    }
    case "status-change":
      setWorkerStatus(w, e.status, "handleEvent.status-change");
      eventBus.publish({
        v: 1,
        type: "agent_status",
        agent: w.agentName,
        status: e.status === "working" ? "working" : "idle",
        since: Date.now(),
      });
      break;
    case "turn-complete": {
      // FRI-12: same cancellation as the error path. If the worker raced
      // to completion right around the abort deadline, the in-flight
      // turn_done is the truthful one — don't kill the worker on top of
      // a successful (or cleanly-aborted) turn.
      clearAbortDeadline(w);
      if (w.forceKilled) break;
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
      // FRI-4 #2 (Layer B): if the SDK abandoned a content block
      // mid-stream and the worker's pre-break flush missed it, the
      // liveTurns map still has it. `dropTurn` below would wipe it and
      // any late `block-stop` would no-op via `handleBlockStop`'s
      // `liveTurns.finishBlock` null-check, leaving the DB row at
      // `status='streaming'`. Finalize as `aborted` first so the row
      // transitions cleanly off `streaming` and the dashboard's bubble
      // moves off `running`.
      finalizeStreamingBlocks(w, "aborted");
      // The in-flight registry holds per-turn block accumulators (FIX_FORWARD
      // 1.4). Drop the entry once the turn completes; canonical block content
      // already lives in the `blocks` table.
      liveTurns.dropTurn(w.turnId);
      // Long-lived worker: flush queued prompt if any. Don't send `stop` — the
      // worker manages its own lifecycle.
      setWorkerStatus(w, "idle", "handleEvent.turn-complete");
      w.completedAtLeastOnce = true;
      w.lastExitStatus = w.abortRequested ? "aborted" : "complete";
      registry.setStatus(w.agentName, "idle");
      // Per-turn recovery sweep: catches any block the live IPC pipeline
      // dropped this turn — most notably tool_result blocks from a mid-
      // turn iterator break (FIX_FORWARD 2.4), where the worker exits the
      // SDK loop at the assistant message boundary before the SDK yields
      // the subsequent user message containing tool_results. The JSONL
      // has them either way (SDK writes JSONL synchronously); recovery
      // backfills into DB. Idempotent + cheap (sub-second on multi-MB
      // JSONLs); fire-and-forget so the IPC handler stays responsive.
      const sessionForRecovery = w.sessionId ?? e.sessionId;
      if (sessionForRecovery) {
        const wd = w.workingDirectory;
        const an = w.agentName;
        setImmediate(() => {
          try {
            recoverFromJsonl([
              { agentName: an, sessionId: sessionForRecovery, workingDirectory: wd },
            ]);
          } catch (err) {
            logger.log("warn", "jsonl-recovery.post-turn.error", {
              agent: an,
              session: sessionForRecovery,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }
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
  // F3-A (PR C): badge only on assistant text. Mail blocks (role=user
  // source=mail) are visible in the recipient's chat scroller, but the
  // orchestrator's *response* to the mail is the user-relevant signal —
  // badging both produced phantom counts (mail-block + later assistant
  // reply → two badges per logical event). The assistant reply that
  // follows mail still triggers exactly one badge.
  if (opts.role !== "assistant") return;
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

function handleBlockCancel(
  w: LiveWorker,
  e: { clientBlockId: string },
): void {
  // Peek the upcoming seq so the live-turns finish call and the SSE event
  // stamp the same number — mirrors the handleBlockStop pattern.
  const peekSeq = eventBus.currentSeq() + 1;
  const live = liveTurns.finishBlock(w.turnId, e.clientBlockId, peekSeq);
  if (!live) return;
  writeAndPublish(
    {
      v: 1,
      type: "block_canceled",
      turn_id: w.turnId,
      agent: w.agentName,
      block_id: live.blockId,
    },
    () => {
      try {
        deleteBlockById(live.blockId);
      } catch (err) {
        logger.log("warn", "blocks.delete.error", {
          agent: w.agentName,
          blockId: live.blockId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
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

/* ---------------- Error block insertion (FRI-12) ---------------- */

export interface ErrorBlockPayload {
  code: string;
  headline: string;
  httpStatus?: number;
  retryAfterSeconds?: number;
  requestId?: string;
  rawMessage: string;
}

/**
 * Persist a synthetic `kind="error"` block for the current turn and publish
 * the matching `block_start` + `block_complete` SSE pair so the dashboard
 * materializes it as an error bubble. Used by the worker `error` IPC path
 * (SDK throws — 529, 429, 401, …) and by the stop force-kill safety net
 * (worker unresponsive after 2s of abort). Idempotent at the row level via
 * the unique `block_id`; callers should not re-invoke for the same failure.
 *
 * The block_index is computed as `max(existing) + 1` from `liveTurns` when
 * available, falling back to `9999` after `dropTurn` has cleared the entry.
 * The exact value doesn't matter for ordering — the dashboard sorts by
 * `ts` / `block_id` — but we keep it monotonic so DB scans look sane.
 */
export function insertErrorBlock(
  w: LiveWorker,
  payload: ErrorBlockPayload,
): { blockId: string } | null {
  const sessionId = w.sessionId ?? "__pending__";
  const blockId = randomUUID();
  const ts = Date.now();
  const lt = liveTurns.getLiveTurn(w.turnId);
  let blockIndex = 9999;
  if (lt) {
    let max = -1;
    for (const live of lt.blocks.values()) {
      if (live.blockIndex > max) max = live.blockIndex;
    }
    if (max >= 0) blockIndex = max + 1;
  }
  const contentJson = JSON.stringify(payload);
  try {
    writeAndPublish(
      {
        v: 1,
        type: "block_start",
        turn_id: w.turnId,
        agent: w.agentName,
        block_id: blockId,
        message_id: null,
        block_index: blockIndex,
        role: "assistant",
        kind: "error",
        source: null,
        ts,
      },
      (seq) => {
        insertBlock({
          blockId,
          turnId: w.turnId,
          agentName: w.agentName,
          sessionId,
          messageId: null,
          blockIndex,
          role: "assistant",
          kind: "error",
          source: null,
          contentJson,
          status: "complete",
          ts,
          lastEventSeq: seq,
        });
      },
    );
    writeAndPublish(
      {
        v: 1,
        type: "block_complete",
        turn_id: w.turnId,
        agent: w.agentName,
        block_id: blockId,
        message_id: null,
        block_index: blockIndex,
        role: "assistant",
        kind: "error",
        source: null,
        content_json: contentJson,
        status: "complete",
        ts,
      },
      (seq) => {
        updateBlock(blockId, { lastEventSeq: seq });
      },
    );
    return { blockId };
  } catch (err) {
    logger.log("warn", "blocks.error.insert.fail", {
      agent: w.agentName,
      turnId: w.turnId,
      blockId,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/* ---------------- In-flight block teardown (F4-A + FRI-4 #2) ---------------- */

/**
 * Finalize any blocks still in flight on a turn — i.e., the daemon emitted
 * `block_start` (DB row at `status='streaming'`, entry in `liveTurns`) but
 * never received a matching `block-stop` IPC. Walks `liveTurns` for
 * `w.turnId` and uses the existing `writeAndPublish` atomic helper to UPDATE
 * the row + publish `block_complete` so the dashboard's bubble transitions
 * off `running`.
 *
 * Called from two sites:
 *
 *   - `child.on("exit")` with status `'error'`: covers SIGTERM (stall
 *     watchdog), SIGKILL, OOM, crash — anything that bypasses
 *     `runQuery`'s try/catch so the worker can't tear down its own
 *     in-flight blocks.
 *
 *   - `case "turn-complete"` with status `'aborted'` (FRI-4 #2,
 *     Layer B): defensive belt-and-braces for the case where the SDK
 *     abandoned a content block mid-stream (no `content_block_stop`
 *     emitted) and the worker's own pre-break flush
 *     (`flushInflightBlocks`) missed it for any reason. Without this,
 *     `dropTurn` wipes the liveTurns entry and `handleBlockStop` would
 *     no-op on any late stop, leaving the row at `status='streaming'`.
 */
export function finalizeStreamingBlocks(
  w: LiveWorker,
  status: "error" | "aborted",
): void {
  const lt = liveTurns.getLiveTurn(w.turnId);
  if (!lt) return;
  for (const live of lt.blocks.values()) {
    const ts = Date.now();
    const contentJson = finalizeLiveBlockContent(live);
    try {
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
          content_json: contentJson,
          status,
          ts,
        },
        (seq) => {
          updateBlock(live.blockId, {
            contentJson,
            status,
            ts,
            lastEventSeq: seq,
          });
        },
      );
    } catch (err) {
      logger.log("warn", "lifecycle.streaming-finalize.error", {
        agent: w.agentName,
        blockId: live.blockId,
        status,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Assemble a content_json payload from a `LiveBlockState` whose worker
 * died without sending `block-stop`. Best-effort: text and thinking get
 * whatever delta text accumulated; tool_use input may be incomplete JSON.
 */
function finalizeLiveBlockContent(live: liveTurns.LiveBlockState): string {
  if (live.kind === "text" || live.kind === "thinking") {
    return JSON.stringify({ text: live.text });
  }
  if (live.kind === "tool_use") {
    let input: unknown = {};
    if (live.partialJson && live.partialJson.length > 0) {
      try {
        input = JSON.parse(live.partialJson);
      } catch {
        input = { _raw: live.partialJson };
      }
    }
    return JSON.stringify({
      tool_use_id: live.tool?.id ?? "",
      name: live.tool?.name ?? "",
      input,
    });
  }
  // tool_result blocks are emitted block-start + block-stop in the same
  // tick by worker.ts's user-message handler, so they almost never sit in
  // liveTurns at exit time. If one does, emit an empty payload — the
  // dashboard will render the bubble as errored without output.
  return JSON.stringify({ tool_use_id: live.tool?.id ?? "", text: "", is_error: true });
}

/* ---------------- User-typed block insertion (FIX_FORWARD 1.2) ---------------- */

export interface RecordUserBlockInput {
  turnId: string;
  agentName: string;
  /** Falls back to '__pending__' if the agent doesn't yet have a session. */
  sessionId?: string;
  text: string;
  source:
    | "user_chat"
    | "mail"
    | "queue_inject"
    | "scratch"
    | "agent_spawn"
    | "schedule"
    | "refork_notice";
  /** `complete` for the common path (block is final the moment it's
   *  written). `queued` for user_chat POSTs that arrived while the agent
   *  was mid-turn — the row is parked until the worker drains it from
   *  `nextPrompts`, at which point `dispatchQueuedPrompt` flips it to
   *  `complete` + new `ts` via `block_meta_update`. Defaults to `complete`. */
  status?: "complete" | "queued";
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
  /** Attachments referenced by this user block (user_chat path). Persisted
   *  into `content_json.attachments` so reload-from-DB rehydrates the chip
   *  row in the dashboard. The bytes live on disk under `~/.friday/uploads`
   *  and are fetched via `GET /api/uploads/<sha>`. */
  attachments?: Array<{ sha256: string; filename: string; mime: string }>;
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
  const status = input.status ?? "complete";
  const attachments =
    input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {};
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
          ...attachments,
        }
      : { text: input.text, ...attachments };
  const contentJson = JSON.stringify(content);
  // FRI-78 follow-up: always publish the canonical `block_complete` SSE
  // frame, including for `user_chat` + `status='complete'`. Prior to this
  // the publish was skipped to avoid racing the POST /api/chat/turn
  // response and double-mounting the optimistic bubble on the sending
  // browser — but that suppression also denied the message to every
  // *other* connected client (browser B, mobile, etc.), so they had to
  // refresh to see the user's own message.
  //
  // The dashboard already has the dedup for the SSE-first ordering:
  // `confirmPending` in chat.svelte.ts collapses a duplicate user
  // bubble when the SSE arrived before the POST response. Pinned by
  // chat.test.ts "drops the optimistic bubble when the SSE
  // block_complete arrived first". The POST-first ordering converges
  // via the natural `handleBlockComplete` id-match: the optimistic was
  // re-keyed to `user_<turnId>` in `confirmPending`, and the
  // subsequent SSE finds the same id and updates in place.
  const seq = writeAndPublish(
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
      status,
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
        status,
        ts,
        lastEventSeq: assignedSeq,
      });
    },
  ).seq;
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
    status,
    contentJson,
  });
  return { blockId, seq };
}
