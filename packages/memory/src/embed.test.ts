/**
 * Fast unit suite for the embedding manager (FRI-24). Drives the manager
 * against a FAKE child transport injected via the `_setSpawnChildForTests`
 * seam — no real subprocess, no model. Exercises the fail-open paths the
 * production recall path depends on: query-time timeout (AC21), child crash
 * mid-operation + respawn (AC20 at the manager layer), and LRU caching.
 *
 * The fake transport is an EventEmitter-backed stand-in for ChildProcess: it
 * records `send`n commands and lets the test emit `ready` / `result` / `exit`
 * to simulate the child. We assert observable behavior (resolved value, spawn
 * call counts, send call counts) — never the manager's internal data
 * structures.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Flush enough microtasks for an `await ensureChild()` continuation chain to
 *  reach the `send()` call after a synchronous `ready()`. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
import {
  EMBED_DIM,
  _resetEmbedForTests,
  _setSpawnChildForTests,
  embedText,
  type EmbedChildTransport,
  type EmbedCommand,
  type EmbedEvent,
} from "./embed.js";

/** A scriptable fake child. `sent` records every command the manager sends;
 *  `ready()` / `reply()` / `crash()` drive the IPC events the manager listens
 *  for. */
class FakeChild extends EventEmitter implements EmbedChildTransport {
  sent: EmbedCommand[] = [];
  killed = false;
  readonly pid = 999_001;
  /** When true, `reply()` auto-fires a valid result for each sent embed. */
  autoReply = false;

  send = vi.fn((msg: EmbedCommand): boolean => {
    this.sent.push(msg);
    if (this.autoReply && msg.type === "embed") {
      // Reply on the next microtask so the manager has registered the inflight
      // entry before the result lands.
      queueMicrotask(() => this.reply(msg.id));
    }
    return true;
  });

  kill = vi.fn((): boolean => {
    this.killed = true;
    return true;
  });

  /** Emit the `ready` handshake. */
  ready(): void {
    this.emit("message", { type: "ready" } satisfies EmbedEvent);
  }

  /** Emit a valid result for a request id (a unit-norm-shaped vector). */
  reply(id: string, vector?: number[]): void {
    const vec = vector ?? new Array<number>(EMBED_DIM).fill(0.1);
    this.emit("message", { type: "result", id, vector: vec, pid: this.pid } satisfies EmbedEvent);
  }

  /** Simulate the child process exiting (crash). */
  crash(code = 1): void {
    this.emit("exit", code, null);
  }
}

describe("embedText manager (fake transport)", () => {
  beforeEach(() => {
    _resetEmbedForTests();
  });
  afterEach(() => {
    _resetEmbedForTests();
  });

  it("query-time fail-open within the timeout (AC21)", async () => {
    const child = new FakeChild();
    const spawn = vi.fn((): EmbedChildTransport => child);
    _setSpawnChildForTests(spawn);

    // Child becomes ready but NEVER replies to the embed command.
    const p = embedText("never answered", { timeoutMs: 50 });
    // Release the ready waiter so the embed command gets sent.
    child.ready();

    const result = await p;
    expect(result).toBe(null);
    // It sent the embed command (so we know we hit the timeout, not the
    // not-ready early-out).
    expect(child.send).toHaveBeenCalledTimes(1);
    expect(child.sent[0]?.type).toBe("embed");
  });

  it("child crash mid-operation → in-flight fails open and next call respawns (AC20)", async () => {
    // Fake timers so we can advance deterministically past the post-crash
    // restart-backoff window (BACKOFF_BASE_MS) instead of sleeping for real.
    // vitest's fake timers also fake Date.now(), which the backoff gate reads.
    vi.useFakeTimers();
    try {
      const first = new FakeChild();
      const second = new FakeChild();
      second.autoReply = true;
      const spawn = vi
        .fn<() => EmbedChildTransport>()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second);
      _setSpawnChildForTests(spawn);

      // First request is in flight when the child crashes.
      const inflight = embedText("doomed", { timeoutMs: 5_000 });
      first.ready();
      // Let the embed command be sent before we crash.
      await flushMicrotasks();
      expect(first.send).toHaveBeenCalledTimes(1);

      first.crash(1);
      const crashedResult = await inflight;
      expect(crashedResult).toBe(null);
      // Only the first generation has been spawned so far.
      expect(spawn).toHaveBeenCalledTimes(1);

      // Advance past the restart-backoff gate so the next embedText is allowed
      // to respawn.
      await vi.advanceTimersByTimeAsync(60_000);

      // A subsequent embedText respawns (spawn factory called a SECOND time).
      const recovered = embedText("after recovery", { timeoutMs: 5_000 });
      second.ready();
      await flushMicrotasks();
      const vec = await recovered;
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(vec).not.toBe(null);
      expect(vec).toHaveLength(EMBED_DIM);
    } finally {
      vi.useRealTimers();
    }
  });

  it("repeated identical query is served from the LRU (transport invoked once)", async () => {
    const child = new FakeChild();
    child.autoReply = true;
    const spawn = vi.fn((): EmbedChildTransport => child);
    _setSpawnChildForTests(spawn);

    const first = embedText("same text", { timeoutMs: 5_000 });
    child.ready();
    const v1 = await first;
    expect(v1).toHaveLength(EMBED_DIM);

    // Second identical call: must hit the cache, NOT the transport.
    const v2 = await embedText("same text", { timeoutMs: 5_000 });
    expect(v2).toEqual(v1);
    // Exactly one embed command was ever sent.
    expect(child.send).toHaveBeenCalledTimes(1);
    expect(child.sent.filter((m) => m.type === "embed")).toHaveLength(1);
  });
});
