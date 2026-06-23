/**
 * FRI-142 (ADR-048): the live in-app Toast queue — the SSE-fed sink for the
 * Toast Channel.
 *
 * A `toast` SSE event (the daemon's Notification router resolved `toast` for an
 * event and this client is present) lands here via the SSE store. A Toast is a
 * fire-and-forget delivery with NO backing row (ADR-024: SSE = ephemeral/live),
 * so this store is the ONLY place it lives — purely in memory, self-dismissing,
 * gone on reload. It must NOT route through `chat.applyEvent` (that store
 * seq-dedups per agent and a toast has no agent — it would be wrongly dropped).
 *
 * This module owns the queue + auto-dismiss timing; the toast *rendering*
 * component is the next dashboard stage's concern and reads `toasts.items`.
 */

import type { ToastEvent } from "@friday/shared";

/** A toast as held in the live queue: the wire payload + a client-side id. */
export interface ToastItem {
  /** Client-local id for keyed rendering + dismissal. */
  id: number;
  title: string;
  body: string;
  /** Same-origin route to navigate to on click; absent ⇒ not actionable. */
  deepLink?: string;
  /** Originating NotifyEventType (for grouping / styling). */
  eventType: string;
  /** 'normal' | 'critical' — critical toasts may render persistently. */
  priority: "normal" | "critical";
}

/** How long a normal toast lingers before auto-dismiss. Critical toasts do not
 *  auto-dismiss — they hold until the user acts. */
const AUTO_DISMISS_MS = 6_000;
/** Cap the visible stack so a burst can't grow unbounded. */
const MAX_TOASTS = 4;

class ToastQueue {
  items = $state<ToastItem[]>([]);
  #nextId = 1;
  #timers = new Map<number, ReturnType<typeof setTimeout>>();

  /** Ingest a `toast` SSE event into the live queue. */
  push(event: ToastEvent): void {
    const id = this.#nextId++;
    const item: ToastItem = {
      id,
      title: event.title,
      body: event.body,
      deepLink: event.deep_link,
      eventType: event.event_type,
      priority: event.priority ?? "normal",
    };
    // Newest first; trim the oldest beyond the cap (dismissing its timer too).
    const next = [item, ...this.items];
    while (next.length > MAX_TOASTS) {
      const dropped = next.pop()!;
      this.#clearTimer(dropped.id);
    }
    this.items = next;
    if (item.priority !== "critical") {
      const t = setTimeout(() => this.dismiss(id), AUTO_DISMISS_MS);
      this.#timers.set(id, t);
    }
  }

  dismiss(id: number): void {
    this.#clearTimer(id);
    this.items = this.items.filter((t) => t.id !== id);
  }

  clear(): void {
    for (const id of this.#timers.keys()) this.#clearTimer(id);
    this.items = [];
  }

  #clearTimer(id: number): void {
    const t = this.#timers.get(id);
    if (t) {
      clearTimeout(t);
      this.#timers.delete(id);
    }
  }
}

export const toasts = new ToastQueue();
