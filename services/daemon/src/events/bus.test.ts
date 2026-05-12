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

  it("eventBus.currentSeq advances on each publish; boot_id is independent", () => {
    const before = eventBus.currentSeq();
    eventBus.publish({
      v: 1,
      type: "system_banner",
      level: "info",
      text: "boot test",
    });
    const after = eventBus.currentSeq();
    expect(after).toBe(before + 1);
    // boot_id never changes regardless of bus activity.
    expect(getBootId()).toBe(getBootId());
  });

  it("replaySince(currentSeq - 500) returns the back-walk window (FIX_FORWARD 1.9)", () => {
    const baseline = eventBus.currentSeq();
    for (let i = 0; i < 700; i++) {
      eventBus.publish({
        v: 1,
        type: "system_banner",
        level: "info",
        text: `walk-${i}`,
      });
    }
    const after = eventBus.currentSeq();
    // The back-walk math the SSE handler uses on a fresh connection.
    const replayFrom = Math.max(0, after - 500);
    const replayed = eventBus.replaySince(replayFrom);
    expect(replayed.length).toBe(500);
    // The lowest seq in the replay is replayFrom + 1, the highest is `after`.
    expect(replayed[0].seq).toBe(replayFrom + 1);
    expect(replayed[replayed.length - 1].seq).toBe(after);
    // Sanity: a baseline-anchored caller still gets everything published
    // after their cursor, bounded by the ring buffer (5000).
    const all = eventBus.replaySince(baseline);
    expect(all.length).toBeLessThanOrEqual(5000);
  });

  it("replaySince(0) returns at most RING_SIZE (5000) most-recent events", () => {
    for (let i = 0; i < 6000; i++) {
      eventBus.publish({
        v: 1,
        type: "system_banner",
        level: "info",
        text: `flood-${i}`,
      });
    }
    const all = eventBus.replaySince(0);
    expect(all.length).toBeLessThanOrEqual(5000);
    expect(all.length).toBe(5000);
  });
});
