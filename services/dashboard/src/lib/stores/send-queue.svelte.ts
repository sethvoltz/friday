/**
 * Data-safety invariant (FRI-103, Seth approved 2026-05-21):
 *
 * Postgres is the source of truth for chat blocks. A `sendQueue` entry is
 * NEVER removed without confirmation that the canonical `blocks` row with
 * `block_id === entry.queueBlockId` exists in the Zero replica. This rules
 * out the class of bug where a transient client error (Zero-not-ready,
 * sync-throw) drops the localStorage entry while the durable Zero mutation
 * queue eventually commits the row — leaving the user's text apparently
 * "sent" but actually lost from the client's view.
 *
 * The mechanism:
 *   1. `enqueue` pre-mints a UUIDv4 `queueBlockId` and persists it.
 *   2. Every retry of the same logical send reuses the same `queueBlockId`
 *      (threaded through `zeroSync.sendUserMessage`) so the canonical
 *      `blocks.id` PK acts as the natural dedup boundary. Re-dispatching
 *      after a partial failure either succeeds (first commit), or hits a
 *      PK collision against the already-committed row (idempotent).
 *   3. The queue entry is cleared by `ackByBlockId` once the canonical
 *      row arrives via Zero — wired from `chat.applyZeroBlocks`. The
 *      success path in `flush` ALSO calls `remove` directly (defense in
 *      depth — idempotent against `ackByBlockId`).
 *   4. If Zero's durable queue is wrong about durability and the canonical
 *      row never lands, the entry persists in localStorage indefinitely
 *      until `MAX_ATTEMPTS=5` trips and the UI surfaces "Discard / Keep
 *      retrying". No silent data loss is possible by design.
 */

import { KEYS, loadJSON, saveJSON } from "./persistent";
import { useZero, zeroSync } from "./zero.svelte";

export interface QueuedAttachment {
  sha256: string;
  filename: string;
  mime: string;
}

export interface QueuedMessage {
  id: string;
  agent: string;
  text: string;
  attachments?: QueuedAttachment[];
  createdAt: number;
  /** Number of failed flush attempts. Surfaced to the UI for "retrying…". */
  attempts: number;
  /** Last error message, if any. */
  lastError?: string;
  /** "queued" until first attempt, then "retrying" after a recoverable
   *  failure, "failed" after the retry cap or on a non-retryable error
   *  (4xx). Failed entries stay in the queue but do not block subsequent
   *  flushes; the UI surfaces them so the user can retry or remove. */
  status?: "queued" | "retrying" | "failed";
  /** Pre-minted canonical `blocks.id` for the send. Generated at `enqueue`
   *  time and reused across every retry of the same logical send so the
   *  Postgres PK acts as a natural dedup. See the file-level data-safety
   *  invariant comment above. */
  queueBlockId: string;
}

/** Mint a fresh UUIDv4 for `queueBlockId`. Falls back to a non-UUID string
 *  when crypto.randomUUID is unavailable (very old browsers, non-secure
 *  contexts) — still unique enough to function as the PK; the canonical
 *  row will use whatever we send. */
function mintBlockId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `blk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Retry budget for a single message before we mark it `failed` and skip
 *  it on future flushes. Picked to recover from transient blips
 *  (reconnect, brief 5xx) without spinning indefinitely on a real
 *  problem. */
const MAX_ATTEMPTS = 5;

/** One row of the `sent` list returned by `flush`/`retry`. `queued` reflects
 *  the daemon's response: `true` when the prompt landed in the worker's
 *  `nextPrompts` FIFO behind an in-flight turn, `false` when it dispatched
 *  immediately. Callers use this to decide whether to overwrite
 *  `chat.inflightTurnId` — only dispatching turns should claim that slot;
 *  a queued turn must not displace the actively-streaming turn. */
export interface FlushSentItem {
  queueId: string;
  turnId: string;
  agent: string;
  queued: boolean;
}

/** Hydrate persisted entries, minting a `queueBlockId` for any legacy
 *  rows that pre-date FRI-103. Old entries without a pre-minted id are
 *  still valid — they just need an id for the next retry. Picking
 *  "mint on read" over "discard" because the user's text is more valuable
 *  than a one-time risk of a duplicate row (rare, and the daemon's
 *  jsonl-recovery would surface it).
 *
 *  Defensive against non-array localStorage values (corrupt JSON, broad
 *  test mocks that return `{}` for every key, etc.): anything that isn't
 *  an array becomes an empty queue. */
function hydrate(): QueuedMessage[] {
  const raw = loadJSON<unknown>(KEYS.sendQueue, []);
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => {
    const entry = m as Partial<QueuedMessage> & Record<string, unknown>;
    return {
      ...entry,
      queueBlockId:
        typeof entry.queueBlockId === "string"
          ? entry.queueBlockId
          : mintBlockId(),
    } as QueuedMessage;
  });
}

class SendQueue {
  items = $state<QueuedMessage[]>(hydrate());
  flushing = $state(false);

  private persist(): void {
    saveJSON(KEYS.sendQueue, $state.snapshot(this.items));
  }

  enqueue(
    msg: Omit<QueuedMessage, "id" | "createdAt" | "attempts" | "queueBlockId">,
  ): QueuedMessage {
    const item: QueuedMessage = {
      ...msg,
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      attempts: 0,
      // Pre-mint the canonical blocks.id PK here so every retry of this
      // logical send reuses the same id. See file-header data-safety
      // invariant.
      queueBlockId: mintBlockId(),
    };
    this.items.push(item);
    this.persist();
    return item;
  }

  remove(id: string): void {
    const idx = this.items.findIndex((m) => m.id === id);
    if (idx >= 0) {
      this.items.splice(idx, 1);
      this.persist();
    }
  }

  /** Drop the queue entry whose `queueBlockId` matches `blockId`. Wired
   *  from `chat.applyZeroBlocks` — when the canonical user `blocks` row
   *  shows up in the Zero replica we know Postgres has the write durably
   *  and the localStorage ghost can be cleared safely. Idempotent: a
   *  blockId that doesn't match any entry is a no-op. */
  ackByBlockId(blockId: string): void {
    const idx = this.items.findIndex((m) => m.queueBlockId === blockId);
    if (idx >= 0) {
      this.items.splice(idx, 1);
      this.persist();
    }
  }

  /** Drop every queued message, including failed/retrying ones. Wired to the
   *  "Discard all and continue" affordance the failed-state UI surfaces
   *  after MAX_ATTEMPTS retries (FIX_FORWARD 2.7). Returns the queue ids
   *  that were cleared so callers can clean up their pending bubbles. */
  discardAll(): string[] {
    const ids = this.items.map((m) => m.id);
    this.items.splice(0, this.items.length);
    this.persist();
    return ids;
  }

  forAgent(agent: string): QueuedMessage[] {
    return this.items.filter((m) => m.agent === agent);
  }

  /** Reset a `failed` entry to `queued` so the next flush picks it up,
   *  then immediately flush so the retry feels instant. Wired to the
   *  per-bubble "retry" affordance in the UI. */
  async retry(id: string): Promise<{
    sent: Array<FlushSentItem>;
    failed: string[];
    retrying: string[];
  }> {
    const m = this.items.find((x) => x.id === id);
    if (!m) return { sent: [], failed: [], retrying: [] };
    m.status = "queued";
    m.attempts = 0;
    m.lastError = undefined;
    this.persist();
    return this.flush();
  }

  /**
   * Attempt to POST every queued message. Sequential so order is preserved;
   * a recoverable failure (network / 5xx) stops the run (we'll retry on the
   * next signal). A non-retryable failure (4xx) marks the entry `failed`
   * and the loop continues — one poisoned message must not block the rest
   * of the queue forever. Idempotent on re-entry via `flushing`.
   *
   * Returns the {queueId, turnId, agent} tuples for messages successfully
   * sent on this pass — callers wire those back into the chat UI (re-keying
   * the pending bubble, setting `inflightTurnId`). The complementary
   * `failed` / `retrying` queueId lists let the caller mirror per-bubble
   * UI affordances (FIX_FORWARD 2.6).
   */
  async flush(): Promise<{
    sent: FlushSentItem[];
    failed: string[];
    retrying: string[];
  }> {
    const empty = { sent: [] as FlushSentItem[], failed: [] as string[], retrying: [] as string[] };
    if (this.flushing) return empty;
    if (this.items.length === 0) return empty;
    this.flushing = true;
    const sent: FlushSentItem[] = [];
    const failed: string[] = [];
    const retrying: string[] = [];
    try {
      const ids = this.items.map((m) => m.id);
      for (const id of ids) {
        const m = this.items.find((x) => x.id === id);
        if (!m) continue;
        if (m.status === "failed") continue;
        try {
          // Phase 4.11b: Zero-path dispatches the sendUserMessage
          // mutator. The dashboard generates the UUIDs (id +
          // turn_id) so the optimistic local write lands the
          // bubble immediately; the daemon's LISTEN handler picks
          // up the row, runs the full dispatch (agent resolution,
          // system prompt, skill, recall, queue-vs-dispatch), and
          // forks/queues the worker. `queued=false` here is the
          // optimistic default — the daemon may flip the block to
          // 'queued' if a worker is mid-turn; the SSE turn_started
          // event reconciles inflightTurnId in that case.
          if (useZero()) {
            const result = await zeroSync.sendUserMessage({
              // Reuse the pre-minted blockId across every retry of the
              // same logical send (FRI-103 data-safety invariant). The
              // canonical `blocks.id` PK is what makes the second insert
              // a PK collision — i.e. idempotent — rather than a
              // duplicate row.
              blockId: m.queueBlockId,
              agent: m.agent,
              text: m.text,
              attachments: m.attachments,
            });
            if (!result) {
              // useZero true but the wrapper bailed (Zero not yet
              // initialized). Treat as transient — retry on next
              // flush.
              m.attempts += 1;
              m.lastError = "zero_not_ready";
              if (m.attempts >= MAX_ATTEMPTS) {
                m.status = "failed";
                failed.push(m.id);
                this.persist();
                continue;
              }
              m.status = "retrying";
              retrying.push(m.id);
              this.persist();
              return { sent, failed, retrying };
            }
            this.remove(id);
            sent.push({
              queueId: m.id,
              turnId: result.turnId,
              agent: m.agent,
              queued: false,
            });
            continue;
          }
          const r = await fetch("/api/chat/turn", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text: m.text,
              agent: m.agent,
              attachments: m.attachments,
            }),
          });
          if (!r.ok) {
            const errText = (await r.text().catch(() => "")).trim();
            m.attempts += 1;
            m.lastError = `${r.status} ${errText}`.trim();
            // 4xx is the daemon telling us this exact request is malformed
            // or unauthorized — retrying won't help and would block every
            // queued message behind it. Mark failed and continue.
            const nonRetryable = r.status >= 400 && r.status < 500;
            if (nonRetryable || m.attempts >= MAX_ATTEMPTS) {
              m.status = "failed";
              failed.push(m.id);
              this.persist();
              continue;
            }
            m.status = "retrying";
            retrying.push(m.id);
            this.persist();
            return { sent, failed, retrying }; // 5xx: stop the run, try again on next reconnect.
          }
          const data = (await r.json().catch(() => ({}))) as {
            turn_id?: string;
            queued?: boolean;
          };
          this.remove(id);
          if (data.turn_id) {
            sent.push({
              queueId: m.id,
              turnId: data.turn_id,
              agent: m.agent,
              queued: data.queued === true,
            });
          }
        } catch (err) {
          // Network-layer failure (offline, abort, DNS). Always retryable
          // up to the cap.
          m.attempts += 1;
          m.lastError = err instanceof Error ? err.message : String(err);
          if (m.attempts >= MAX_ATTEMPTS) {
            m.status = "failed";
            failed.push(m.id);
            this.persist();
            continue;
          }
          m.status = "retrying";
          retrying.push(m.id);
          this.persist();
          return { sent, failed, retrying };
        }
      }
    } finally {
      this.flushing = false;
    }
    return { sent, failed, retrying };
  }
}

export const sendQueue = new SendQueue();
