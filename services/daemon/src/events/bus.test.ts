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
      type: "system_banner",
      level: "info",
      text: "boot test",
    });
    expect(eventBus.currentSeq()).toBe(before + 1);
  });

  it("replaySince(currentSeq - 500) returns the back-walk window (FIX_FORWARD 1.9)", () => {
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
  });

  it("replaySince(0) returns the 5000 most-recent events, oldest dropped", () => {
    for (let i = 0; i < 6000; i++) {
      eventBus.publish({
        v: 1,
        type: "system_banner",
        level: "info",
        text: `flood-${i}`,
      });
    }
    const head = eventBus.currentSeq();
    const all = eventBus.replaySince(0);
    expect(all.length).toBe(5000);
    // "Most-recent" is the load-bearing claim — pin the boundaries so a
    // regression that returned the *oldest* 5000 (or any off-by-one
    // window) fails. The tail should be the latest publish; the head
    // should be `head - 4999`.
    expect(all[all.length - 1]!.seq).toBe(head);
    expect(all[0]!.seq).toBe(head - 4999);
  });
});
