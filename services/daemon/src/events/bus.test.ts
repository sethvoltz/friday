import { describe, expect, it } from "vitest";
import { eventBus, getBootId, getBootTs } from "./bus.js";

describe("event bus boot_id (FIX_FORWARD 1.6)", () => {
  it("getBootId returns a stable UUID across calls", () => {
    const a = getBootId();
    const b = getBootId();
    expect(a).toBe(b);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("getBootTs returns a finite timestamp set at module load", () => {
    const t = getBootTs();
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(Date.now());
  });

  it("eventBus.currentSeq advances by exactly 1 per publish", () => {
    const before = eventBus.currentSeq();
    eventBus.publish({
      v: 1,
      type: "block_canceled",
      turn_id: "t-bus-1",
      agent: "a-bus-counter",
      block_id: "blk-bus-1",
    });
    expect(eventBus.currentSeq()).toBe(before + 1);
  });
});

describe("event bus per-turn buffer (Phase 5)", () => {
  // The buffer is module-scoped; pick unique agent + turn ids per
  // test so tests don't leak buffer state into one another.
  function freshAgent(label: string): string {
    return `bus-test-${label}-${Math.random().toString(36).slice(2, 8)}`;
  }

  it("turn_started opens a buffer for the agent; subsequent events accumulate", () => {
    const agent = freshAgent("accumulate");
    eventBus.publish({
      v: 1,
      type: "turn_started",
      turn_id: "t-accumulate",
      agent,
      ts: 1,
    });
    eventBus.publish({
      v: 1,
      type: "block_start",
      turn_id: "t-accumulate",
      agent,
      block_id: "blk-1",
      message_id: null,
      block_index: 0,
      role: "assistant",
      kind: "text",
      source: "sdk",
      ts: 2,
    });
    eventBus.publish({
      v: 1,
      type: "block_canceled",
      turn_id: "t-accumulate",
      agent,
      block_id: "blk-1",
    });
    const replayed = eventBus.replayForAgent(agent);
    const types = replayed.map((e) => e.type);
    expect(types).toContain("turn_started");
    expect(types).toContain("block_start");
    expect(types).toContain("block_canceled");
  });

  it("turn_done evicts the buffer immediately (next replay returns empty)", () => {
    const agent = freshAgent("evict");
    eventBus.publish({
      v: 1,
      type: "turn_started",
      turn_id: "t-evict",
      agent,
      ts: 1,
    });
    eventBus.publish({
      v: 1,
      type: "block_canceled",
      turn_id: "t-evict",
      agent,
      block_id: "blk-evict",
    });
    eventBus.publish({
      v: 1,
      type: "turn_done",
      turn_id: "t-evict",
      agent,
      status: "complete",
    });
    const replayed = eventBus.replayForAgent(agent);
    // After turn_done the buffer is evicted; no events remain for
    // this agent until a fresh turn_started opens a new buffer.
    expect(replayed.filter((e) => "agent" in e && e.agent === agent)).toEqual(
      [],
    );
  });

  it("a fresh turn_started for the same agent replaces the prior turn's buffer", () => {
    // Defensive: a worker that emits a second turn_started without a
    // preceding turn_done (orphaned turn after a crash + immediate
    // re-dispatch) shouldn't accumulate both turns in the same
    // buffer. The new turn evicts the old one.
    const agent = freshAgent("reset");
    eventBus.publish({
      v: 1,
      type: "turn_started",
      turn_id: "t-old",
      agent,
      ts: 1,
    });
    eventBus.publish({
      v: 1,
      type: "block_canceled",
      turn_id: "t-old",
      agent,
      block_id: "blk-old",
    });
    eventBus.publish({
      v: 1,
      type: "turn_started",
      turn_id: "t-new",
      agent,
      ts: 2,
    });
    const replayed = eventBus.replayForAgent(agent);
    const turnIds = new Set(
      replayed
        .filter((e) => "turn_id" in e)
        .map((e) => (e as { turn_id: string }).turn_id),
    );
    expect(turnIds.has("t-old")).toBe(false);
    expect(turnIds.has("t-new")).toBe(true);
  });

  it("per-turn cap drops the oldest event when more than 2000 land in a single turn", () => {
    // Defensive bound — a runaway worker (stuck loop, broken
    // streaming) can't grow the per-turn buffer past TURN_CAP_EVENTS
    // (2000). The oldest events shift out; the cap is what keeps
    // memory bounded.
    const agent = freshAgent("cap");
    eventBus.publish({
      v: 1,
      type: "turn_started",
      turn_id: "t-cap",
      agent,
      ts: 1,
    });
    for (let i = 0; i < 2500; i++) {
      eventBus.publish({
        v: 1,
        type: "block_canceled",
        turn_id: "t-cap",
        agent,
        block_id: `blk-cap-${i}`,
      });
    }
    const replayed = eventBus.replayForAgent(agent);
    // turn_started (1) + capped overflow buffer (2000) = 2001 max.
    expect(replayed.length).toBeLessThanOrEqual(2001);
    // Most-recent claim: the tail event should be the last published.
    const tail = replayed[replayed.length - 1] as { block_id?: string };
    expect(tail.block_id).toBe("blk-cap-2499");
  });

  it("multiple agents maintain independent buffers", () => {
    const a1 = freshAgent("multi-a");
    const a2 = freshAgent("multi-b");
    eventBus.publish({
      v: 1,
      type: "turn_started",
      turn_id: "t-a",
      agent: a1,
      ts: 1,
    });
    eventBus.publish({
      v: 1,
      type: "turn_started",
      turn_id: "t-b",
      agent: a2,
      ts: 2,
    });
    eventBus.publish({
      v: 1,
      type: "block_canceled",
      turn_id: "t-a",
      agent: a1,
      block_id: "blk-multi-a",
    });
    eventBus.publish({
      v: 1,
      type: "block_canceled",
      turn_id: "t-b",
      agent: a2,
      block_id: "blk-multi-b",
    });
    const replayedA = eventBus.replayForAgent(a1);
    const replayedB = eventBus.replayForAgent(a2);
    const blockIdsA = new Set(
      replayedA
        .filter((e) => "block_id" in e)
        .map((e) => (e as { block_id: string }).block_id),
    );
    const blockIdsB = new Set(
      replayedB
        .filter((e) => "block_id" in e)
        .map((e) => (e as { block_id: string }).block_id),
    );
    expect(blockIdsA.has("blk-multi-a")).toBe(true);
    expect(blockIdsA.has("blk-multi-b")).toBe(false);
    expect(blockIdsB.has("blk-multi-b")).toBe(true);
    expect(blockIdsB.has("blk-multi-a")).toBe(false);
  });

  it("ambient events (no `agent` field) live in their own ring, returned alongside any agent replay", () => {
    const agent = freshAgent("ambient");
    eventBus.publish({
      v: 1,
      type: "app_lifecycle",
      event: "installed",
      app: "test-ambient-app",
      version: "1.0.0",
    });
    eventBus.publish({
      v: 1,
      type: "turn_started",
      turn_id: "t-ambient",
      agent,
      ts: 1,
    });
    const replayed = eventBus.replayForAgent(agent);
    const apps = replayed.filter((e) => e.type === "app_lifecycle");
    expect(apps.length).toBeGreaterThan(0);
  });
});
