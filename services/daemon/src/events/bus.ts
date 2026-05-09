import { EventEmitter } from "node:events";
import type { WireEvent } from "@friday/shared";

// Token-level streaming (text_delta + thinking_delta + tool_use_input partials)
// emits hundreds-to-thousands of events per turn. The ring buffer is the only
// reconnection-replay surface for in-flight state, so it has to be big enough
// that a mid-stream page refresh can reconstruct the active turn from it.
// 5000 events ~= ~500 KB at typical event size; comfortably fits a long
// orchestrator turn with thinking + several tool calls.
const RING_SIZE = 5000;

/** Distribute Omit across the discriminated union so callers can construct
 * a single variant without `seq`. Without this, TS treats the input as the
 * intersection of all variants. */
type WireEventInput = WireEvent extends infer U
  ? U extends WireEvent
    ? Omit<U, "seq">
    : never
  : never;

class EventBus {
  private seq = 0;
  private ring: WireEvent[] = [];
  private em = new EventEmitter();

  constructor() {
    this.em.setMaxListeners(0);
  }

  publish(event: WireEventInput): WireEvent {
    this.seq++;
    const full = { ...event, seq: this.seq } as WireEvent;
    this.ring.push(full);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    this.em.emit("event", full);
    return full;
  }

  /** Replay events with seq strictly greater than `lastSeq`. */
  replaySince(lastSeq: number): WireEvent[] {
    return this.ring.filter((e) => e.seq > lastSeq);
  }

  subscribe(listener: (e: WireEvent) => void): () => void {
    this.em.on("event", listener);
    return () => this.em.off("event", listener);
  }

  currentSeq(): number {
    return this.seq;
  }
}

export const eventBus = new EventBus();
