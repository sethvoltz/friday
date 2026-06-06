import { describe, expect, it } from "vitest";
import type { ChatMessage } from "$lib/stores/chat.svelte";
import {
  compactionDividerCountByTurn,
  compactionDividerId,
  isViewingPreCompaction,
  isViewingPreCompactionUnmounted,
} from "./compaction-render";

/** Minimal ChatMessage factory for the divider-convergence helper. */
function dividerMsg(blockId: string, turnId: string, ts: number): ChatMessage {
  return {
    id: compactionDividerId(blockId),
    role: "assistant",
    kind: "compaction",
    text: "",
    status: "complete",
    agent: "friday",
    turnId,
    ts,
    preTokens: 779_000,
    postTokens: 50_000,
  };
}

function textMsg(id: string, turnId: string, ts: number): ChatMessage {
  return {
    id,
    role: "assistant",
    text: "hi",
    status: "complete",
    agent: "friday",
    turnId,
    ts,
  };
}

describe("compactionDividerId", () => {
  it("derives the stable cb_<blockId> id parseBlocks emits", () => {
    expect(compactionDividerId("blk-abc")).toBe("cb_blk-abc");
  });
});

describe("compactionDividerCountByTurn — distinct-divider counting", () => {
  // The live `compacting` SSE event emits NO divider (only a transient
  // spinner), so the durable block is the SOLE divider producer. The pure
  // helper counts distinct cb_<blockId> dividers grouped by turn. (The actual
  // optimistic↔canonical convergence — live `compacting` event vs the durable
  // block — is exercised at the store layer in chat.test.ts: the two signals
  // write disjoint state, so there is nothing for the orderings to converge
  // on; this helper only counts the block-derived dividers.)

  it("one durable divider for a turn counts as 1", () => {
    const list: ChatMessage[] = [textMsg("b_u1", "t1", 100), dividerMsg("blk-1", "t1", 200)];
    const counts = compactionDividerCountByTurn(list);
    expect(counts.get("t1")).toBe(1);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("a turn with NO divider has no entry", () => {
    const liveOnly: ChatMessage[] = [textMsg("b_u1", "t1", 100)];
    expect(compactionDividerCountByTurn(liveOnly).get("t1")).toBeUndefined();
  });

  it("two distinct markers on the SAME turn count as 2 (a long turn compacted twice — legitimate)", () => {
    // The daemon inserts one marker per compact_boundary frame, so a turn the
    // SDK trims twice yields two distinct cb_<blockId> dividers on one turn.
    // The "at most one divider" framing applies to optimistic↔canonical
    // convergence of a SINGLE block (de-dupe by id), NOT to multi-compaction:
    // two distinct blocks correctly count as 2.
    const counts = compactionDividerCountByTurn([
      dividerMsg("blk-1", "t1", 100),
      dividerMsg("blk-2", "t1", 200),
    ]);
    expect(counts.get("t1")).toBe(2);
  });

  it("de-dupes a list that accidentally carries two messages sharing a divider id", () => {
    // A keyed {#each} would crash on a duplicate id; the helper counts
    // DISTINCT ids so a buggy merge that double-pushed the same cb_<blockId>
    // still counts as 1 (the convergence-by-id invariant).
    const dup = dividerMsg("blk-1", "t1", 200);
    const counts = compactionDividerCountByTurn([dividerMsg("blk-1", "t1", 200), { ...dup }]);
    expect(counts.get("t1")).toBe(1);
  });

  it("counts dividers across multiple turns independently", () => {
    const counts = compactionDividerCountByTurn([
      dividerMsg("blk-1", "t1", 100),
      dividerMsg("blk-2", "t2", 300),
    ]);
    expect(counts.get("t1")).toBe(1);
    expect(counts.get("t2")).toBe(1);
  });
});

describe("isViewingPreCompaction — pill-visibility geometry", () => {
  it("pill OFF when the divider intersects the viewport", () => {
    expect(
      isViewingPreCompaction({ dividerTop: 300, viewportBottom: 800, isIntersecting: true }),
    ).toBe(false);
  });

  it("pill ON when the divider sits below the viewport bottom (scrolled above)", () => {
    // dividerTop (900) >= viewportBottom (800): the divider is past the
    // bottom edge → the user is scrolled above it → pre-compaction history.
    expect(
      isViewingPreCompaction({ dividerTop: 900, viewportBottom: 800, isIntersecting: false }),
    ).toBe(true);
  });

  it("pill OFF when the divider is above the viewport top (scrolled past it)", () => {
    // dividerTop (-50) < viewportBottom (800): the divider has scrolled off
    // the TOP, so the user is looking at post-compaction (recent) history.
    expect(
      isViewingPreCompaction({ dividerTop: -50, viewportBottom: 800, isIntersecting: false }),
    ).toBe(false);
  });

  it("pill ON at the exact boundary (divider top == viewport bottom)", () => {
    expect(
      isViewingPreCompaction({ dividerTop: 800, viewportBottom: 800, isIntersecting: false }),
    ).toBe(true);
  });
});

describe("isViewingPreCompactionUnmounted — pill state for an out-of-window divider", () => {
  // The virtualization window [windowStart, windowEnd) tracks the live tail of
  // an oldest→newest list (idx 0 = oldest). When the divider's index is OUTSIDE
  // the window there's no element to observe, so the pill is decided purely by
  // index-vs-window. This pins both unmounted branches — neither is exercised by
  // the e2e (which seeds 32 messages, all in one WINDOW_SIZE=100 slice).

  it("pill ON when the divider is BELOW the window (dividerIdx >= windowEnd → user is above it)", () => {
    // window [400,500), divider at 600 → every rendered message is older than
    // the divider → user is scrolled above it → pre-compaction.
    expect(
      isViewingPreCompactionUnmounted({ dividerIdx: 600, windowStart: 400, windowEnd: 500 }),
    ).toBe(true);
  });

  it("pill ON at the lower boundary (dividerIdx === windowEnd, divider just past the slice bottom)", () => {
    // The window slice is half-open [start, end), so index === end is the first
    // row BELOW the rendered slice → user is above it → pill ON.
    expect(
      isViewingPreCompactionUnmounted({ dividerIdx: 500, windowStart: 400, windowEnd: 500 }),
    ).toBe(true);
  });

  it("pill OFF when the divider is ABOVE the window (dividerIdx < windowStart → user is below it, post-compaction tail)", () => {
    // THE BUG GUARD: long, frequently-compacted session — divider at index 50,
    // window pinned at the tail [400,500). A wheel-scroll-up flips pinnedToBottom
    // false BEFORE the top sentinel slides windowStart down to the divider. The
    // user is still looking at messages 400-499, all NEWER than the divider →
    // the pill must stay OFF (the old `!pinnedToBottom` heuristic wrongly flashed
    // it ON here). This helper takes no pinned state precisely so it can't.
    expect(
      isViewingPreCompactionUnmounted({ dividerIdx: 50, windowStart: 400, windowEnd: 500 }),
    ).toBe(false);
  });

  it("pill OFF at the upper boundary (dividerIdx === windowStart - 1, divider just above the slice top)", () => {
    expect(
      isViewingPreCompactionUnmounted({ dividerIdx: 399, windowStart: 400, windowEnd: 500 }),
    ).toBe(false);
  });
});
