/**
 * block-injectors — synthetic block writers that piggyback on the block-stream
 * FSM's accumulator (FRI-148 B).
 *
 * Split from block-stream.ts so the FSM core (open/append/close/cancel +
 * finalize/endTurn) owns ONLY the per-block lifecycle; the synthetic writers
 * that synthesize a born-closed row outside that lifecycle live here. Both
 * injectors:
 *
 *   - recordError    — synthesize an `error` block for the current turn
 *                      (FRI-12 path). Uses {@link peekNextBlockIndex} to
 *                      compute the block_index relative to the live turn's
 *                      in-flight blocks; falls back to `9999` post-finalize
 *                      when the turn entry is gone from the accumulator
 *                      (load-bearing per the ticket §3 design correction —
 *                      do NOT throw in the no-live-turn case).
 *
 *   - recordUserBlock — persist a user-role block ahead of (or alongside) a
 *                       dispatched turn. The row lands with
 *                       `status='complete'` (or `'queued'` when the agent
 *                       was already busy at POST time); there is no
 *                       streaming lifecycle for user-typed / mail content.
 *
 * Both call `maybeEmitAgentMessage` from block-stream.ts so user-visible
 * assistant text + completed mail blocks still fan out to the dashboard
 * badge SSE (FIX_FORWARD 2.8).
 */

import { randomUUID } from "node:crypto";

import { insertBlock } from "@friday/shared/services";

import { eventBus } from "../events/bus.js";
import { logger } from "../log.js";
import { maybeEmitAgentMessage, peekNextBlockIndex } from "./block-stream.js";
import type { LiveWorker } from "./lifecycle.js";

/* ---------------- recordError ---------------- */

/**
 * Payload shape for the synthetic error block (FRI-12 path). Kept here in
 * the injectors module so the worker-error code path in lifecycle.ts can
 * construct one without round-tripping through block-stream.ts (the FSM
 * core no longer references this type).
 */
export interface ErrorBlockPayload {
  code: string;
  headline: string;
  httpStatus?: number;
  retryAfterSeconds?: number;
  requestId?: string;
  rawMessage: string;
}

/**
 * Synthesize an error block for the current turn (FRI-12 path).
 * Persists one row with `kind="error"` + `status="complete"`, then
 * publishes the matching `block_start` + `block_complete` pair so the
 * dashboard materializes the error bubble.
 *
 * Idempotent at the row level via `block_id` uniqueness. The block_index
 * comes from {@link peekNextBlockIndex}: when the turn is still live in
 * the accumulator it is `max(existing in-flight) + 1`; when the turn has
 * already been finalized (the live entry was dropped by
 * {@link endTurn} / `forceKillStuckWorker`'s teardown) the accessor returns
 * `turnLive: false` and we fall back to `9999`. The fallback is
 * load-bearing per FRI-148 §3 — error blocks landing on already-finalized
 * turns must still persist with a deterministic, sort-last index rather
 * than throw.
 */
export async function recordError(
  w: LiveWorker,
  payload: ErrorBlockPayload,
): Promise<{ blockId: string } | null> {
  const sessionId = w.sessionId ?? "__pending__";
  const blockId = randomUUID();
  const ts = Date.now();
  const { index, turnLive } = peekNextBlockIndex(w.turnId);
  const blockIndex = turnLive ? index : 9999;
  const contentJson = JSON.stringify(payload);

  try {
    await insertBlock({
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
    });
  } catch (err) {
    logger.log("warn", "blocks.error.insert.fail", {
      agent: w.agentName,
      turnId: w.turnId,
      blockId,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  eventBus.publish({
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
  });
  eventBus.publish({
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
  });
  return { blockId };
}

/* ---------------- recordUserBlock ---------------- */

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
    | "refork_notice"
    | "reminder";
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
 *
 * FRI-125: absorbed from lifecycle.ts under the C2 deepening; the
 * inlined INSERT + publish replaces the prior `writeAndPublish`
 * helper. Returned `seq` is the eventBus's per-event sequence number,
 * stamped at publish time.
 */
export async function recordUserBlock(input: RecordUserBlockInput): Promise<{
  blockId: string;
  seq: number;
}> {
  const blockId = randomUUID();
  const ts = Date.now();
  const status = input.status ?? "complete";
  const attachments =
    input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {};
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
  await insertBlock({
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
  });
  const { seq } = eventBus.publish({
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
  });
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
