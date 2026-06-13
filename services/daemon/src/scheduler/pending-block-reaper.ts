/**
 * Pending-block reaper — SEV-0 "no user message is ever lost" backstop.
 *
 * THE GAP THIS CLOSES. A `user_chat` block is committed to Postgres at
 * status `pending` (the discriminator only the `sendUserMessage` mutator
 * writes). A trigger fires `NOTIFY friday_new_pending_block`; the daemon's
 * dispatch listener (agent/dispatch-listener.ts) consumes it and starts the
 * turn. Two ways that row can then sit `pending` FOREVER while the daemon is
 * live:
 *
 *   1. Missed NOTIFY — Postgres `NOTIFY` is fire-and-forget. If the LISTEN
 *      socket is mid-reconnect, the payload is dropped between the commit and
 *      the listener re-attaching (the listener's post-(re)connect boot scan
 *      only re-drains on RECONNECT, not for a notify missed while otherwise
 *      live).
 *   2. The boot scan's shape-mismatch skip — `processPendingBlockRow` skips a
 *      `pending` row whose role/source isn't `user`/`user_chat` (a structurally
 *      undispatchable row), `return`ing without flipping it out of `pending`.
 *
 * In BOTH cases no turn starts → no zero-block is produced → the zero-block
 * safety net never fires → the user's message is silently lost. The boot scan
 * only re-picks pending rows at daemon STARTUP, never for a live-daemon missed
 * NOTIFY. This reaper is the live-daemon equivalent: a periodic sweep that
 * GUARANTEES no `user_chat` block stays undispatched.
 *
 * It COMPLEMENTS, and does not replace, the zero-block net: the zero-block net
 * catches a turn that ran and produced nothing; the reaper catches a turn that
 * never ran at all.
 *
 * STRUCTURE (modeled on scheduler/compaction-sweep.ts): an unref'd
 * `setInterval`, a pure clock-injected selection core (`selectStalePending`)
 * exported for unit tests, a `__tickForTest` seam, and start/stop wired into
 * daemon boot/shutdown. Re-dispatch funnels through the SAME
 * `processPendingBlockRow` the NOTIFY listener and boot scan use (imported, not
 * duplicated) — that function re-reads the row, no-ops if its status has
 * already flipped, AND gates its dispatch on its claiming `WHERE
 * status='pending'` UPDATE actually matching a row (rowCount === 1). The
 * rowCount gate — not the re-read alone — is the authoritative guard against
 * double-dispatching a row the normal NOTIFY path (or a concurrent caller) is
 * claiming: the loser's UPDATE matches zero rows and it returns before
 * dispatch.
 */

import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb, schema } from "@friday/shared";
import { logger } from "../log.js";
import { processPendingBlockRow } from "../agent/dispatch-listener.js";

/** ~30s poll. Frequent enough to bound a lost user message to tens of seconds,
 *  cheap enough (one indexed scan) to run forever. */
const TICK_MS = 30_000;

/** A block must be at least this old before the reaper touches it. The normal
 *  NOTIFY → listener path resolves a `pending` row in milliseconds, so this
 *  age gate lets that path win the race in the common case: the reaper only
 *  acts on rows the live path demonstrably DIDN'T pick up. Kept comfortably
 *  above the listener's reconnect backoff floor (1s) so a row landing during a
 *  brief reconnect blip is reaped on the next reconnect's boot scan first, and
 *  only falls to the reaper if even that is missed. */
const STALE_THRESHOLD_MS = 45_000;

/** The single status a still-undispatched user block sits in: `pending` — the
 *  un-picked-up state the `sendUserMessage` mutator writes and the NOTIFY/boot
 *  paths claim. We deliberately do NOT scan `queued`:
 *
 *    - A `queued` user_chat row is a legitimately-in-flight turn parked behind a
 *      live worker; it drains when the worker hits `nextPrompts`. Re-running
 *      `processPendingBlockRow` on it is a no-op (status != 'pending' →
 *      short-circuit), so scanning it buys nothing — but a turn that
 *      legitimately sits `queued` for >45s (a long live turn ahead of it) would
 *      emit a spurious `block.reaper.stale-found` warn + `block.reaper.redispatch`
 *      info EVERY tick until it drains. Pure noise.
 *    - The `blocks_pending` partial index predicate is `status IN
 *      ('pending','abort_requested')`, which does NOT cover `queued`. Scanning
 *      `pending` only keeps this scan fully index-served; adding `queued` would
 *      have forced a non-index scan, contradicting the "index-served" claim.
 *
 *  (Dead-`queued` recovery — a worker that died mid-queue without draining and
 *  whose `recoverQueuedTurns` boot pass missed it — is a real but distinct
 *  concern; if it ever bites, it warrants its own non-noisy recovery path, not a
 *  no-op re-scan here. Raised in the PR comment.) */
const SCAN_STATUSES = ["pending"] as const;

let interval: NodeJS.Timeout | null = null;
/** Re-entrancy guard: a pass slower than the tick must not let a second tick
 *  enter and re-select the same rows before the first finishes. (Each row's
 *  dispatch is independently idempotent via the status re-read in
 *  `processPendingBlockRow`, but bailing overlap cleanly is cheaper and matches
 *  compaction-sweep's guard.) */
let reaping = false;

/** Minimal row shape the pure selector needs. */
export interface PendingBlockRow {
  id: string;
  blockId: string;
  turnId: string;
  agentName: string;
  sessionId: string;
  role: string;
  source: string | null;
  /** Milliseconds since epoch. */
  ts: number;
}

/**
 * Pure selection policy: of the candidate rows, the ones the reaper should act
 * on this pass — those whose `ts` is older than `STALE_THRESHOLD_MS` relative
 * to the injected `now`. A fresh / in-flight row (younger than the threshold)
 * is left alone so the normal NOTIFY path wins the common-case race. Clock is
 * injected so this is unit-testable without fake timers (repo convention).
 */
export function selectStalePending(rows: PendingBlockRow[], now: number): PendingBlockRow[] {
  const cutoff = now - STALE_THRESHOLD_MS;
  return rows.filter((r) => r.ts <= cutoff);
}

/**
 * Classify a candidate row. A `user`/`user_chat` row is DISPATCHABLE — it
 * funnels through `processPendingBlockRow`. Any other shape is the
 * structurally-undispatchable case the boot scan silently skips (it `return`s
 * without flipping the row), so it would be re-scanned by this reaper forever
 * AND never surface to the user. We treat it explicitly (see `reapOne`).
 */
function isDispatchable(row: PendingBlockRow): boolean {
  return row.role === "user" && row.source === "user_chat";
}

/**
 * Non-silent handling for a stale user-role `pending` row whose `source` is NOT
 * `user_chat`.
 *
 * INVARIANT this protects. Only the `sendUserMessage` mutator writes a user
 * block at `status='pending'`, and it only ever writes `source='user_chat'`.
 * Every other user-role block (mail, reminder, schedule, …) is recorded
 * directly at `status='complete'` (or, per `RecordUserBlockInput.status`,
 * `'queued'`). So a non-`user_chat` user row sitting in the reaper's
 * `pending` scan is an INVARIANT VIOLATION — a bug somewhere upstream — not a
 * routine stranded message.
 *
 * Why we do NOT error-flip / synthesize an error block here (the prior
 * behavior): `RecordUserBlockInput.status` permits `'queued'` for ANY source,
 * so a FUTURE path could legitimately put an in-flight `queued` non-`user_chat`
 * block in front of this scan. Destructively flipping any non-`user_chat` row
 * to `error` on source ALONE would clobber that legitimate in-flight row and
 * surface a false "could not be delivered" bubble. Identifying the row by
 * `source` is not a safe basis for a destructive action.
 *
 * Safer choice: SURFACE the violation as a `warn` (so a real bug is observable
 * in telemetry) and LEAVE THE ROW UNTOUCHED. The cost is that a genuinely
 * stranded non-`user_chat` `pending` row would be re-warned each tick — but
 * that state should never occur under the invariant, and a recurring warn is a
 * loud, non-destructive signal to fix the upstream writer, which is exactly
 * what we want. We do not clobber data on a heuristic.
 */
async function surfaceUndispatchable(row: PendingBlockRow): Promise<void> {
  logger.log("warn", "block.reaper.invariant-violation", {
    block_id: row.blockId,
    role: row.role,
    source: row.source,
    status: "pending",
    note: "user-role pending block with source != 'user_chat' — only sendUserMessage should write user 'pending' rows, and only as 'user_chat'. NOT dispatching and NOT flipping (a flip on source alone could clobber a legit future queued non-user_chat block). Investigate the upstream writer.",
  });
}

/**
 * Re-dispatch (or surface) one stale candidate.
 *
 * No double-dispatch: dispatchable rows go through `processPendingBlockRow`,
 * which (a) re-reads the row by id and short-circuits if its status is no
 * longer `pending`, AND (b) gates its `dispatchTurn` on its claiming UPDATE
 * having actually matched a `WHERE status='pending'` row (rowCount === 1). So a
 * row the normal NOTIFY path claimed in the window between this pass's SELECT
 * and here — or one a second caller is claiming concurrently — is NOT
 * double-dispatched: the loser's UPDATE matches zero rows and it returns before
 * dispatch. Non-`user_chat` rows are surfaced as an invariant-violation warn
 * (see `surfaceUndispatchable`); they are NOT mutated.
 */
async function reapOne(row: PendingBlockRow): Promise<void> {
  if (!isDispatchable(row)) {
    await surfaceUndispatchable(row);
    return;
  }
  logger.log("info", "block.reaper.redispatch", {
    block_id: row.blockId,
    agent: row.agentName,
    ageMs: Date.now() - row.ts,
  });
  // Idempotent + claim-guarded: re-reads the row, and even if two callers pass
  // that read, only the one whose UPDATE wins `WHERE status='pending'`
  // dispatches.
  await processPendingBlockRow(row.blockId);
}

/**
 * One reaper pass. Selects user-role `pending` blocks, narrows to the stale
 * ones via the pure selector, and reaps each. `now` is injected for the test
 * seam.
 */
async function runReap(now: number = Date.now()): Promise<void> {
  if (reaping) return;
  reaping = true;
  try {
    const db = getDb();
    // role='user' scopes us to the user_chat silent-loss surface and keeps the
    // scan off assistant/system rows. The pure selector applies the age gate.
    const dbRows = await db
      .select({
        id: schema.blocks.id,
        blockId: schema.blocks.blockId,
        turnId: schema.blocks.turnId,
        agentName: schema.blocks.agentName,
        sessionId: schema.blocks.sessionId,
        role: schema.blocks.role,
        source: schema.blocks.source,
        ts: schema.blocks.ts,
      })
      .from(schema.blocks)
      .where(
        and(
          inArray(schema.blocks.status, [...SCAN_STATUSES]),
          eq(schema.blocks.role, "user"),
          // Pre-filter by the cutoff in SQL too so a large queued backlog
          // doesn't get pulled into memory; the pure selector re-asserts it.
          lt(schema.blocks.ts, new Date(now - STALE_THRESHOLD_MS)),
        ),
      );

    const rows: PendingBlockRow[] = dbRows.map((r) => ({
      id: r.id,
      blockId: r.blockId,
      turnId: r.turnId,
      agentName: r.agentName,
      sessionId: r.sessionId,
      role: r.role,
      source: r.source,
      ts: r.ts.getTime(),
    }));

    const stale = selectStalePending(rows, now);
    if (stale.length === 0) return;
    logger.log("warn", "block.reaper.stale-found", { count: stale.length });

    for (const row of stale) {
      try {
        await reapOne(row);
      } catch (err) {
        logger.log("warn", "block.reaper.reap.error", {
          block_id: row.blockId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    reaping = false;
  }
}

export function startPendingBlockReaper(): NodeJS.Timeout {
  if (interval) return interval;
  interval = setInterval(
    () =>
      void runReap().catch((err) =>
        logger.log("warn", "block.reaper.error", { message: String(err) }),
      ),
    TICK_MS,
  );
  interval.unref();
  return interval;
}

export function stopPendingBlockReaper(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  reaping = false;
}

/**
 * Test seam (mirrors compaction-sweep's `__runSweepForTest`): drive a single
 * reaper pass synchronously with an injected `now`, awaiting its I/O. Not for
 * production.
 */
export async function __tickForTest(now: number): Promise<void> {
  await runReap(now);
}

/** Test-only: reset the in-memory re-entrancy guard between cases. */
export function __resetForTest(): void {
  reaping = false;
}
