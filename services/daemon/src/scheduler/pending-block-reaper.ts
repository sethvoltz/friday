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
 * duplicated) — that function re-reads the row and no-ops if its status has
 * already flipped, which IS the TOCTOU guard against double-dispatching a row
 * the normal NOTIFY path just claimed.
 */

import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb, schema } from "@friday/shared";
import { insertBlock } from "@friday/shared/services";
import { randomUUID } from "node:crypto";
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

/** The statuses a still-undispatched user block can sit in. `pending` is the
 *  un-picked-up state; `queued` rows were accepted by the daemon but, if the
 *  worker that owned the queue died without draining (and recovery missed it),
 *  can also strand — re-running `processPendingBlockRow` is a no-op for a
 *  `queued` row whose turn is genuinely in flight (status != 'pending' →
 *  short-circuit), so including it here is safe and strictly more protective.
 *  Note: the `blocks_pending` partial index covers ('pending','abort_requested')
 *  only, so the `pending` arm of this scan is index-served; the `queued` arm
 *  falls to the `blocks_agent_ts`/seq scan, which is fine at this cadence and
 *  the table's pending-row cardinality. */
const SCAN_STATUSES = ["pending", "queued"] as const;

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
 * Non-silent handling for a structurally-undispatchable stale pending row.
 *
 * Cleanest non-silent outcome: surface a VISIBLE `error` block on the row's own
 * turn (so the user sees the message wasn't processed instead of it vanishing)
 * AND flip the original row OUT of `pending`/`queued` into `error` so this
 * reaper does not re-scan it every 30s forever. We log a `warn` either way.
 *
 * The error block is born-closed (`kind:'error'`, `status:'complete'`),
 * mirroring `block-injectors.recordError` but without a LiveWorker (there is no
 * live turn for an un-dispatched row). `block_index` is the sort-last `9999`
 * sentinel the injectors use for post-finalize error blocks.
 */
async function surfaceUndispatchable(row: PendingBlockRow): Promise<void> {
  const db = getDb();
  logger.log("warn", "block.reaper.undispatchable", {
    block_id: row.blockId,
    role: row.role,
    source: row.source,
    note: "structurally undispatchable stale pending block — surfacing error block and marking error so it is not re-scanned",
  });

  // Visible error bubble bound to the stranded row's own turn.
  try {
    await insertBlock({
      blockId: randomUUID(),
      turnId: row.turnId,
      agentName: row.agentName,
      sessionId: row.sessionId,
      messageId: null,
      blockIndex: 9999,
      role: "assistant",
      kind: "error",
      source: null,
      contentJson: JSON.stringify({
        code: "undispatchable_pending_block",
        headline: "This message could not be delivered.",
        rawMessage: `A user message was persisted but had an unexpected shape (role=${row.role}, source=${row.source ?? "null"}) and could not be dispatched. It has been surfaced here rather than dropped silently.`,
      }),
      status: "complete",
      ts: Date.now(),
    });
  } catch (err) {
    // Best-effort surface; the status flip below is the load-bearing part that
    // stops the infinite re-scan. Log and continue.
    logger.log("warn", "block.reaper.error-block.insert.fail", {
      block_id: row.blockId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Flip OUT of the scanned statuses so it isn't re-reaped forever. Guarded on
  // the still-stranded status so we never clobber a row another path claimed.
  await db
    .update(schema.blocks)
    .set({ status: "error" })
    .where(and(eq(schema.blocks.id, row.id), inArray(schema.blocks.status, [...SCAN_STATUSES])));
}

/**
 * Re-dispatch (or surface) one stale candidate.
 *
 * TOCTOU re-read: dispatchable rows go through `processPendingBlockRow`, which
 * re-reads the row by id and short-circuits if its status is no longer
 * `pending` — so a row the normal NOTIFY path claimed in the window between
 * this pass's SELECT and here is NOT double-dispatched. Undispatchable rows are
 * surfaced + marked so they leave the scan set.
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
  // Idempotent: re-reads the row, no-ops if status already flipped (TOCTOU).
  await processPendingBlockRow(row.blockId);
}

/**
 * One reaper pass. Selects user-role `pending`/`queued` blocks, narrows to the
 * stale ones via the pure selector, and reaps each. `now` is injected for the
 * test seam.
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
