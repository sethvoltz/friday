/**
 * Embedding manager (FRI-24). Owns a daemon-supervised, forked child process
 * that hosts the all-MiniLM-L6-v2 feature-extraction pipeline and answers
 * `embed` requests over IPC. The public seam is {@link embedText}: it returns a
 * 384-float L2-normalized vector, or `null` on ANY failure (timeout, child
 * down, transformers error, empty result). FAIL-OPEN by design — a missing or
 * crashed embedder degrades semantic recall to FTS-only; it never throws into
 * the recall path and never blocks daemon boot. The pgvector EXTENSION, by
 * contrast, is a hard schema dependency ensured at provision time; this module
 * is purely the runtime that POPULATES the column.
 *
 * Supervision mirrors the daemon's worker lifecycle (services/daemon/src/agent/
 * lifecycle.ts): lazy spawn, a `ready` handshake, restart-with-backoff on
 * exit/error, and an idle timer that reaps the child after a quiet period so a
 * long-idle daemon isn't holding ~240MB of onnxruntime resident. The next
 * `embedText` respawns transparently.
 *
 * The child-spawn factory is injectable ({@link _setSpawnChildForTests}) so the
 * fast unit suite can drive timeout / crash / restart / fail-open paths against
 * a fake transport with no real subprocess. The real fork lives in
 * embed-child.ts (compiled to dist/embed-child.js).
 */

import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDING_DIM } from "@friday/shared";

// ---------------------------------------------------------------------------
// Code-default constants. Declared BEFORE any process.env read so the env
// vars below can override them; never written to .env (system defaults live in
// code per the project convention). All durations are milliseconds.
// ---------------------------------------------------------------------------

/** HuggingFace model id for the local embedder. Override: FRIDAY_EMBED_MODEL. */
export const MODEL_ID = process.env.FRIDAY_EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";

/** Output vector dimensionality — the single source of truth shared with the
 *  pgvector `vector(N)` column (schema.ts). */
export const EMBED_DIM = EMBEDDING_DIM;

/** ONNX intra-op thread cap, forwarded to the child. Keeping this small avoids
 *  a single embed saturating the box during a backfill. Override:
 *  FRIDAY_EMBED_THREADS. */
export const EMBED_THREADS = process.env.FRIDAY_EMBED_THREADS ?? "2";

/** Query-time embed timeout. A live recall must not hang on a wedged child —
 *  fail open to FTS-only fast. Override: FRIDAY_EMBED_TIMEOUT_MS. */
export const EMBED_TIMEOUT_MS = Number(process.env.FRIDAY_EMBED_TIMEOUT_MS ?? 5_000);

/** Warm/backfill embed timeout — generous, since the FIRST embed after a cold
 *  spawn pays the model-load cost (~hundreds of ms to a few s) and a backfill
 *  embed can be longer text. Override: FRIDAY_EMBED_WARM_TIMEOUT_MS. */
export const EMBED_WARM_TIMEOUT_MS = Number(process.env.FRIDAY_EMBED_WARM_TIMEOUT_MS ?? 120_000);

/** Reap the child after this much idle time so a quiet daemon releases the
 *  onnxruntime resident set. Override: FRIDAY_EMBED_IDLE_SHUTDOWN_MS. */
export const IDLE_SHUTDOWN_MS = Number(process.env.FRIDAY_EMBED_IDLE_SHUTDOWN_MS ?? 60_000);

/** LRU cache size (by exact text). Override: FRIDAY_EMBED_LRU_SIZE. */
export const LRU_SIZE = Number(process.env.FRIDAY_EMBED_LRU_SIZE ?? 256);

/** Restart backoff base + cap. After an exit/error we wait
 *  `min(cap, base * 2**consecutiveFailures)` before the next spawn is allowed.
 *  Override: FRIDAY_EMBED_BACKOFF_BASE_MS / FRIDAY_EMBED_BACKOFF_CAP_MS. */
export const BACKOFF_BASE_MS = Number(process.env.FRIDAY_EMBED_BACKOFF_BASE_MS ?? 500);
export const BACKOFF_CAP_MS = Number(process.env.FRIDAY_EMBED_BACKOFF_CAP_MS ?? 30_000);

// ---------------------------------------------------------------------------
// IPC protocol. Parent → child commands and child → parent events, both
// discriminated on `type`. The child also stamps its own pid on a result so the
// integration test can prove the embed ran out-of-process.
// ---------------------------------------------------------------------------

export type EmbedCommand = { type: "embed"; id: string; text: string };

export type EmbedEvent =
  | { type: "ready" }
  | { type: "result"; id: string; vector: number[]; pid: number }
  | { type: "error"; id: string; message: string };

/** The transport surface the manager needs from a child. `ChildProcess`
 *  satisfies it structurally; the fake transport in the unit suite implements
 *  exactly these members. */
export interface EmbedChildTransport {
  send?: (msg: EmbedCommand) => boolean;
  on(event: "message", listener: (msg: EmbedEvent) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  readonly pid?: number;
}

/** A pending request awaiting its child reply. */
interface Inflight {
  resolve: (vector: number[] | null) => void;
  timer: NodeJS.Timeout;
}

// ---------------------------------------------------------------------------
// Default child factory: a plain `child_process.fork` of the sibling
// embed-child.js. @friday/memory is always consumed as built dist (even in
// dev), so resolving the sibling next to THIS module's compiled location lands
// on dist/embed-child.js in both dev and prod. `fork` gives us the IPC channel
// and execArgv forwarding for free.
// ---------------------------------------------------------------------------

// In prod/dev this module runs from dist/embed.js, so the sibling
// dist/embed-child.js exists. Under vitest the SOURCE (src/embed.ts) runs, where
// the sibling is src/embed-child.js (a .ts, no .js) — so fall back to the built
// dist/embed-child.js (turbo's test:e2e dependsOn build, so it's present).
function resolveChildPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = join(here, "embed-child.js");
  if (existsSync(sibling)) return sibling;
  return join(here, "..", "dist", "embed-child.js");
}

const CHILD_PATH = resolveChildPath();

function defaultSpawnChild(): EmbedChildTransport {
  const child: ChildProcess = fork(CHILD_PATH, [], {
    env: {
      ...process.env,
      FRIDAY_EMBED_MODEL: MODEL_ID,
      FRIDAY_EMBED_THREADS: EMBED_THREADS,
    },
    // Inherit stdio so the child's transformers warnings surface in the daemon
    // log stream; keep the IPC channel (default for fork).
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  return child as unknown as EmbedChildTransport;
}

/** Module-level, overridable for tests. Tests inject a fake transport via
 *  {@link _setSpawnChildForTests} to exercise the manager without a real
 *  subprocess. */
let spawnChild: () => EmbedChildTransport = defaultSpawnChild;

// ---------------------------------------------------------------------------
// Manager state. A tiny state machine: no child → spawning → ready, with
// down/backoff between generations. Only one child at a time.
// ---------------------------------------------------------------------------

let child: EmbedChildTransport | null = null;
/** True once the current child has emitted `ready`; requests wait for this. */
let childReady = false;
/** Resolvers waiting for the current child to become ready. */
let readyWaiters: Array<() => void> = [];
/** In-flight requests keyed by request id. */
const inflight = new Map<string, Inflight>();
/** Consecutive spawn-to-failure count, drives the restart backoff. Reset on a
 *  clean `ready`. */
let consecutiveFailures = 0;
/** Earliest wall-clock at which the next spawn is allowed (backoff gate). */
let nextSpawnAllowedAt = 0;
/** Idle reaper timer; cleared on each request, re-armed when inflight drains. */
let idleTimer: NodeJS.Timeout | null = null;

/** LRU cache: text → vector. Insertion-order Map; oldest evicted first. */
const cache = new Map<string, number[]>();

function cacheGet(text: string): number[] | undefined {
  const hit = cache.get(text);
  if (hit === undefined) return undefined;
  // Refresh recency: re-insert at the tail.
  cache.delete(text);
  cache.set(text, hit);
  return hit;
}

function cacheSet(text: string, vector: number[]): void {
  if (cache.has(text)) cache.delete(text);
  cache.set(text, vector);
  while (cache.size > LRU_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function send(msg: EmbedCommand): boolean {
  if (child && typeof child.send === "function") {
    try {
      return child.send(msg) === true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Reject (fail-open: resolve null) every in-flight request and clear timers.
 *  Called when the child goes down. */
function failAllInflight(): void {
  for (const [, pending] of inflight) {
    clearTimeout(pending.timer);
    pending.resolve(null);
  }
  inflight.clear();
}

/** Tear down the current child generation: mark down, fail in-flight, drop the
 *  ready waiters (a respawn re-arms them). Does NOT kill — used both for an
 *  observed exit (already dead) and as a precursor to a deliberate kill. */
function markChildDown(): void {
  child = null;
  childReady = false;
  failAllInflight();
  for (const w of readyWaiters) w();
  readyWaiters = [];
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Only reap when genuinely idle — a request that arrived in the gap keeps
    // the child alive.
    if (inflight.size === 0) {
      killChild();
    }
  }, IDLE_SHUTDOWN_MS);
  // Don't keep the daemon process alive solely for the reaper.
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

function killChild(): void {
  const c = child;
  markChildDown();
  if (c) {
    try {
      c.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}

/** Ensure a live, ready child exists, honoring the backoff gate. Resolves true
 *  if the child is (or becomes) ready, false if the backoff window hasn't
 *  elapsed or the spawn failed. */
async function ensureChild(): Promise<boolean> {
  if (child && childReady) return true;
  if (!child) {
    const now = Date.now();
    if (now < nextSpawnAllowedAt) return false;
    spawnNewChild();
  }
  // A child exists (just spawned or mid-spawn) — wait for its `ready`.
  if (childReady) return true;
  await new Promise<void>((resolve) => {
    readyWaiters.push(resolve);
  });
  return childReady;
}

function spawnNewChild(): void {
  let c: EmbedChildTransport;
  try {
    c = spawnChild();
  } catch {
    // Spawn threw synchronously (bad path, fd exhaustion). Treat as a failure
    // generation and back off.
    onChildFailure();
    return;
  }
  child = c;
  childReady = false;

  c.on("message", (msg: EmbedEvent) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ready") {
      childReady = true;
      consecutiveFailures = 0;
      const waiters = readyWaiters;
      readyWaiters = [];
      for (const w of waiters) w();
      return;
    }
    if (msg.type === "result") {
      const pending = inflight.get(msg.id);
      if (!pending) return;
      inflight.delete(msg.id);
      clearTimeout(pending.timer);
      const vec = Array.isArray(msg.vector) ? msg.vector : null;
      pending.resolve(vec && vec.length === EMBED_DIM ? vec : null);
      if (inflight.size === 0) armIdleTimer();
      return;
    }
    if (msg.type === "error") {
      const pending = inflight.get(msg.id);
      if (!pending) return;
      inflight.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve(null);
      if (inflight.size === 0) armIdleTimer();
      return;
    }
  });

  c.on("exit", () => {
    // Only react if this is still the current generation (a deliberate
    // killChild() already nulled `child`).
    if (child === c) {
      onChildFailure();
    }
  });

  c.on("error", () => {
    if (child === c) {
      onChildFailure();
    }
  });
}

/** A child generation failed (exit/error/spawn-throw). Bump the backoff,
 *  fail in-flight requests open, and schedule the next spawn gate. The next
 *  `embedText` after the gate elapses respawns. */
function onChildFailure(): void {
  consecutiveFailures += 1;
  const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1));
  nextSpawnAllowedAt = Date.now() + backoff;
  markChildDown();
}

/**
 * Embed `text` into a 384-float L2-normalized vector, or `null` on any failure
 * (FAIL-OPEN). Served from an LRU cache when seen before. Lazily spawns the
 * child (subject to restart backoff). A timeout, a child crash, a transformers
 * error, or an empty/mis-sized result all resolve `null` — the call NEVER
 * throws and NEVER hangs past `timeoutMs`.
 */
export async function embedText(
  text: string,
  opts?: { timeoutMs?: number },
): Promise<number[] | null> {
  const cached = cacheGet(text);
  if (cached !== undefined) return cached;

  const timeoutMs = opts?.timeoutMs ?? EMBED_TIMEOUT_MS;

  const ready = await ensureChild();
  if (!ready || !child) return null;

  const id = randomUUID();
  return await new Promise<number[] | null>((resolve) => {
    const timer = setTimeout(() => {
      // Timed out: drop the pending request and fail open. Leave the child
      // alive — a single slow embed shouldn't tear down the generation.
      if (inflight.has(id)) {
        inflight.delete(id);
        resolve(null);
        if (inflight.size === 0) armIdleTimer();
      }
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const settle = (vector: number[] | null): void => {
      if (vector && vector.length === EMBED_DIM) cacheSet(text, vector);
      resolve(vector);
    };

    inflight.set(id, { resolve: settle, timer });
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    const ok = send({ type: "embed", id, text });
    if (!ok) {
      // Send failed (child died between ensureChild and now). Fail open.
      inflight.delete(id);
      clearTimeout(timer);
      resolve(null);
      // Re-arm the idle reaper if this was the last in-flight request — the
      // other terminal paths (success/timeout/error) do this; without it a
      // send-false on a still-alive child could leak the child unreaped.
      if (inflight.size === 0) armIdleTimer();
    }
  });
}

/**
 * Best-effort warm: ensure the child is up and the model is loaded by running a
 * single short embed with the generous warm timeout. Returns true if the warm
 * embed produced a valid vector, false otherwise. Never throws.
 */
export async function warmEmbedChild(): Promise<boolean> {
  const vec = await embedText("warm", { timeoutMs: EMBED_WARM_TIMEOUT_MS });
  return Array.isArray(vec) && vec.length === EMBED_DIM;
}

/** Gracefully shut the child down (SIGTERM) and clear all manager state. The
 *  next `embedText` respawns. */
export function shutdownEmbedChild(): void {
  killChild();
}

/**
 * Test-only: inject a fake child-spawn factory. Pass `undefined` to restore the
 * real `fork`-based factory.
 */
export function _setSpawnChildForTests(fn: (() => EmbedChildTransport) | undefined): void {
  spawnChild = fn ?? defaultSpawnChild;
}

/**
 * Test-only: reset ALL manager state between tests — kills any live child,
 * clears the LRU + in-flight maps, resets the backoff ledger, and restores the
 * real spawn factory. Call in `afterEach`.
 */
export function _resetEmbedForTests(): void {
  if (child) {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
  child = null;
  childReady = false;
  readyWaiters = [];
  for (const [, pending] of inflight) clearTimeout(pending.timer);
  inflight.clear();
  consecutiveFailures = 0;
  nextSpawnAllowedAt = 0;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  cache.clear();
  spawnChild = defaultSpawnChild;
}
