import { describe, expect, it } from "vitest";
import type { ChatMessage } from "$lib/stores/chat.svelte";
import {
  compactionDividerCountByTurn,
  compactionDividerId,
  isViewingPreCompaction,
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

describe("compactionDividerCountByTurn — optimistic↔canonical convergence", () => {
  // The live `compacting` SSE event emits NO divider (only a transient
  // spinner), so the durable block is the SOLE divider producer. These two
  // tests pin that exactly ONE divider renders per turn regardless of which
  // signal the UI observed first — the both-interleavings rule. Because the
  // divider set is derived purely from the block rows, "live status first"
  // and "durable block first" reduce to the same message list once the block
  // has been parsed; we model each ordering's resulting list explicitly.

  it("durable-block-FIRST then live-status: one divider for the turn", () => {
    // Ordering A: the kind:'compaction' block replicated via Zero first
    // (parseBlocks emitted the divider), THEN the live `compacting` phase:'done'
    // arrived (which toggles only the spinner, adds no message). Resulting
    // list still has exactly one divider message for turn t1.
    const afterBlockThenStatus: ChatMessage[] = [
      textMsg("b_u1", "t1", 100),
      dividerMsg("blk-1", "t1", 200),
    ];
    const counts = compactionDividerCountByTurn(afterBlockThenStatus);
    expect(counts.get("t1")).toBe(1);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("live-status-FIRST then durable-block: still one divider for the turn", () => {
    // Ordering B: the live `compacting` phase:'start'/'done' fired first
    // (spinner only — zero divider messages), THEN the durable block
    // replicated and parseBlocks emitted the divider. Because the live path
    // contributes no divider message, the converged list is identical to
    // ordering A: exactly one divider for t1, no duplicate.
    const liveOnly: ChatMessage[] = [textMsg("b_u1", "t1", 100)];
    expect(compactionDividerCountByTurn(liveOnly).get("t1")).toBeUndefined();

    const afterStatusThenBlock: ChatMessage[] = [
      textMsg("b_u1", "t1", 100),
      dividerMsg("blk-1", "t1", 200),
    ];
    const counts = compactionDividerCountByTurn(afterStatusThenBlock);
    expect(counts.get("t1")).toBe(1);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("de-dupes a list that accidentally carries two messages sharing a divider id", () => {
    // A keyed {#each} would crash on a duplicate id; the helper counts
    // DISTINCT ids so the invariant ("one divider per turn") is upheld even
    // if a buggy merge double-pushed the same cb_<blockId>.
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
