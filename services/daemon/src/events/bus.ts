import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { WireEvent } from "@friday/shared";

// Phase 5: the 5000-event global ring buffer is retired in favor of
// per-agent per-turn buffers (plan §210). Each turn's buffer:
//   - starts on `turn_started` for that agent + turn_id,
//   - accumulates every wire event tagged with that agent until
//     `turn_done` lands,
//   - is evicted immediately on `turn_done` (the turn is closed; live
//     subscribers still received the terminal event).
//
// Memory savings come from automatic eviction. The hard cap below is
// a defensive bound — a runaway turn (broken worker, stuck SDK loop)
// can't grow the buffer past `TURN_CAP_EVENTS`. Typical orchestrator
// turns land 100–500 events; 2000 covers long reasoning runs with
// many tool calls without inviting an OOM on a misbehaving worker.
const TURN_CAP_EVENTS = 2000;

// Some events (`app_lifecycle`, `connection_established`) have no
// `agent` field — daemon-level signals that any connected client
// should see. They live in a small ambient ring that survives across
// turns. Sized small because the only consumer is a fresh-connect
// replay; live subscribers see them in-flight.
const AMBIENT_CAP_EVENTS = 200;

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

interface TurnBuffer {
  turnId: string;
  events: WireEvent[];
}

class EventBus {
  private seq = 0;
  /** Per-agent currently-active turn buffer. A new `turn_started`
   *  for an agent replaces any existing entry (covers the worker-
   *  resumes-mid-flight case where a prior turn never finalized). */
  private turns = new Map<string, TurnBuffer>();
  /** Events with no `agent` field (daemon-level signals). */
  private ambient: WireEvent[] = [];
  private em = new EventEmitter();

  constructor() {
    this.em.setMaxListeners(0);
  }

  publish(event: WireEventInput): WireEvent {
    this.seq++;
    const full = { ...event, seq: this.seq } as WireEvent;
    this.route(full);
    this.em.emit("event", full);
    return full;
  }

  private route(e: WireEvent): void {
    // turn_started opens (or resets) the agent's turn buffer.
    if (e.type === "turn_started") {
      this.turns.set(e.agent, { turnId: e.turn_id, events: [e] });
      return;
    }
    // turn_done closes the buffer. We append the terminal event so
    // a connection that lands within the same tick still sees the
    // turn finishing — then evict.
    if (e.type === "turn_done") {
      const t = this.turns.get(e.agent);
      if (t && t.turnId === e.turn_id) t.events.push(e);
      this.turns.delete(e.agent);
      return;
    }
    // Per-agent events go to that agent's open turn buffer if any.
    // If no buffer is open (the event preceded turn_started — should
    // be impossible under ADR-024 ordering, but defensive), the
    // event is broadcast live only and not stored for replay.
    if ("agent" in e && typeof e.agent === "string") {
      const t = this.turns.get(e.agent);
      if (t) {
        t.events.push(e);
        if (t.events.length > TURN_CAP_EVENTS) t.events.shift();
      }
      return;
    }
    // Agentless events go to the ambient ring.
    this.ambient.push(e);
    if (this.ambient.length > AMBIENT_CAP_EVENTS) this.ambient.shift();
  }

  /**
   * Phase 5: replay strictly newer events across every active turn
   * buffer + the ambient ring. The SSE handler still calls this via
   * the legacy `Last-Event-ID` cursor for connections that haven't
   * yet moved to the per-agent `?agent=` model. With the per-turn
   * cap this remains bounded — typical worst case is one open turn
   * with up to 2000 events + ~200 ambient events.
   */
  replaySince(lastSeq: number): WireEvent[] {
    const out: WireEvent[] = [];
    for (const e of this.ambient) {
      if (e.seq > lastSeq) out.push(e);
    }
    for (const t of this.turns.values()) {
      for (const e of t.events) {
        if (e.seq > lastSeq) out.push(e);
      }
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /**
   * Phase 5: replay the current turn buffer for a specific agent.
   * Used by the per-agent SSE handler (`?agent=<name>`) on every
   * fresh connect — the daemon doesn't track per-client cursors
   * anymore, so the buffer's entire current contents form the
   * "from turn start" replay. Ambient events are prepended so
   * connection-handshake metadata still reaches every client.
   */
  replayForAgent(agent: string): WireEvent[] {
    const t = this.turns.get(agent);
    const turnEvents = t ? t.events.slice() : [];
    return [...this.ambient, ...turnEvents];
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
