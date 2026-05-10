import { KEYS, loadJSON, saveJSON } from "./persistent";

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
}

/** Retry budget for a single message before we mark it `failed` and skip
 *  it on future flushes. Picked to recover from transient blips
 *  (reconnect, brief 5xx) without spinning indefinitely on a real
 *  problem. */
const MAX_ATTEMPTS = 5;

class SendQueue {
  items = $state<QueuedMessage[]>(loadJSON<QueuedMessage[]>(KEYS.sendQueue, []));
  flushing = $state(false);

  private persist(): void {
    saveJSON(KEYS.sendQueue, $state.snapshot(this.items));
  }

  enqueue(msg: Omit<QueuedMessage, "id" | "createdAt" | "attempts">): QueuedMessage {
    const item: QueuedMessage = {
      ...msg,
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      attempts: 0,
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

  forAgent(agent: string): QueuedMessage[] {
    return this.items.filter((m) => m.agent === agent);
  }

  /** Reset a `failed` entry to `queued` so the next flush picks it up,
   *  then immediately flush so the retry feels instant. Wired to the
   *  per-bubble "retry" affordance in the UI. */
  async retry(id: string): Promise<Array<{ queueId: string; turnId: string; agent: string }>> {
    const m = this.items.find((x) => x.id === id);
    if (!m) return [];
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
   * sent on this pass — callers wire those back into the chat UI (clearing
   * the "queued" pill, setting `inflightTurnId`).
   */
  async flush(): Promise<Array<{ queueId: string; turnId: string; agent: string }>> {
    if (this.flushing) return [];
    if (this.items.length === 0) return [];
    this.flushing = true;
    const sent: Array<{ queueId: string; turnId: string; agent: string }> = [];
    try {
      const ids = this.items.map((m) => m.id);
      for (const id of ids) {
        const m = this.items.find((x) => x.id === id);
        if (!m) continue;
        if (m.status === "failed") continue;
        try {
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
              this.persist();
              continue;
            }
            m.status = "retrying";
            this.persist();
            return sent; // 5xx: stop the run, try again on next reconnect.
          }
          const data = (await r.json().catch(() => ({}))) as { turn_id?: string };
          this.remove(id);
          if (data.turn_id) {
            sent.push({ queueId: m.id, turnId: data.turn_id, agent: m.agent });
          }
        } catch (err) {
          // Network-layer failure (offline, abort, DNS). Always retryable
          // up to the cap.
          m.attempts += 1;
          m.lastError = err instanceof Error ? err.message : String(err);
          if (m.attempts >= MAX_ATTEMPTS) {
            m.status = "failed";
            this.persist();
            continue;
          }
          m.status = "retrying";
          this.persist();
          return sent;
        }
      }
    } finally {
      this.flushing = false;
    }
    return sent;
  }
}

export const sendQueue = new SendQueue();
