import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { WireEvent } from "@friday/shared";

// block_delta streaming emits hundreds-to-thousands of events per turn. The
// ring buffer is the only reconnection-replay surface for in-flight state, so
// it has to be big enough that a mid-stream page refresh can reconstruct the
// active turn from it. 5000 events ~= ~500 KB at typical event size;
// comfortably fits a long orchestrator turn with thinking + several tool
// calls. FIX_FORWARD 1.9 holds this size as ADR-tracked.
const RING_SIZE = 5000;

/**
 * UUID minted exactly once per daemon process. Carried on every
 * `connection_established` SSE event (FIX_FORWARD 1.6). Clients cache it and
 * reset their per-agent cursors on mismatch — the canonical signal that the
 * daemon's seq counter has rolled back due to a restart.
 */
const BOOT_ID = randomUUID();
const BOOT_TS = Date.now();

export function getBootId(): string {
  return BOOT_ID;
}

export function getBootTs(): number {
  return BOOT_TS;
}

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
