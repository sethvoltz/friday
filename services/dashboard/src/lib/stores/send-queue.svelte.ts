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
}

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

  /**
   * Attempt to POST every queued message. Sequential so order is preserved;
   * any failure stops the run (we'll retry on the next signal). Idempotent on
   * re-entry via `flushing`. Returns the {queueId, turnId, agent} tuples for
   * messages successfully sent on this pass — callers wire those back into
   * the chat UI (clearing the "queued" pill, setting `inflightTurnId`).
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
            m.attempts += 1;
            m.lastError = `${r.status} ${await r.text().catch(() => "")}`.trim();
            this.persist();
            return sent;
          }
          const data = (await r.json().catch(() => ({}))) as { turn_id?: string };
          this.remove(id);
          if (data.turn_id) {
            sent.push({ queueId: m.id, turnId: data.turn_id, agent: m.agent });
          }
        } catch (err) {
          m.attempts += 1;
          m.lastError = err instanceof Error ? err.message : String(err);
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
