import { describe, expect, it } from "vitest";
import type { ChatMessage } from "$lib/stores/chat.svelte";
import { computeGroupingMeta } from "./chat-grouping.js";

type Partial<T> = { [P in keyof T]?: T[P] };

function mk(over: Partial<ChatMessage> & Pick<ChatMessage, "id" | "ts" | "role">): ChatMessage {
  return {
    text: "",
    status: "complete",
    ...over,
  } as ChatMessage;
}

const T0 = new Date(2026, 4, 17, 14, 0, 0, 0).getTime();
const MIN = 60_000;

describe("computeGroupingMeta", () => {
  it("flags the first message as first-in-group and prints a day separator", () => {
    const meta = computeGroupingMeta([
      mk({ id: "u1", role: "user", ts: T0 }),
    ]);
    expect(meta).toEqual([
      { showDaySeparator: true, showInactivitySeparator: false, isFirstInGroup: true, isContinuation: false },
    ]);
  });

  it("groups same-author messages within 5 minutes", () => {
    const meta = computeGroupingMeta([
      mk({ id: "u1", role: "user", ts: T0 }),
      mk({ id: "u2", role: "user", ts: T0 + 2 * MIN }),
      mk({ id: "u3", role: "user", ts: T0 + 4 * MIN }),
    ]);
    expect(meta[1].isFirstInGroup).toBe(false);
    expect(meta[2].isFirstInGroup).toBe(false);
    expect(meta[1].showDaySeparator).toBe(false);
    expect(meta[1].showInactivitySeparator).toBe(false);
  });

  it("breaks group when same-author gap exceeds 5 minutes (no separator if <=1h)", () => {
    const meta = computeGroupingMeta([
      mk({ id: "u1", role: "user", ts: T0 }),
      mk({ id: "u2", role: "user", ts: T0 + 6 * MIN }),
    ]);
    expect(meta[1].isFirstInGroup).toBe(true);
    expect(meta[1].showInactivitySeparator).toBe(false);
    expect(meta[1].showDaySeparator).toBe(false);
  });

  it("does not break at exactly 5 minutes (boundary is strict >5min)", () => {
    const meta = computeGroupingMeta([
      mk({ id: "u1", role: "user", ts: T0 }),
      mk({ id: "u2", role: "user", ts: T0 + 5 * MIN }),
    ]);
    expect(meta[1].isFirstInGroup).toBe(false);
  });

  it("breaks group on author change even within 5 minutes", () => {
    const meta = computeGroupingMeta([
      mk({ id: "u1", role: "user", ts: T0 }),
      mk({ id: "a1", role: "assistant", agent: "friday", ts: T0 + 30_000 }),
    ]);
    expect(meta[1].isFirstInGroup).toBe(true);
    expect(meta[1].showDaySeparator).toBe(false);
    expect(meta[1].showInactivitySeparator).toBe(false);
  });

  it("fires inactivity separator on >1h same-day gap", () => {
    const meta = computeGroupingMeta([
      mk({ id: "u1", role: "user", ts: T0 }),
      mk({ id: "u2", role: "user", ts: T0 + 61 * MIN }),
    ]);
    expect(meta[1].showInactivitySeparator).toBe(true);
    expect(meta[1].showDaySeparator).toBe(false);
    expect(meta[1].isFirstInGroup).toBe(true);
  });

  it("day wins over inactivity when both would fire", () => {
    // T0 at 14:00 local; next message next day at 09:00 local — gap >1h
    // AND crosses local midnight. Day separator should win; inactivity
    // separator should NOT appear.
    const next = new Date(2026, 4, 18, 9, 0, 0, 0).getTime();
    const meta = computeGroupingMeta([
      mk({ id: "u1", role: "user", ts: T0 }),
      mk({ id: "u2", role: "user", ts: next }),
    ]);
    expect(meta[1].showDaySeparator).toBe(true);
    expect(meta[1].showInactivitySeparator).toBe(false);
    expect(meta[1].isFirstInGroup).toBe(true);
  });

  it("treats tool blocks as continuations that don't break grouping", () => {
    const meta = computeGroupingMeta([
      mk({ id: "u1", role: "user", ts: T0 }),
      mk({ id: "a1", role: "assistant", agent: "friday", ts: T0 + 30_000 }),
      mk({ id: "t1", role: "tool", ts: T0 + 31_000 }),
      mk({ id: "a2", role: "assistant", agent: "friday", ts: T0 + 32_000 }),
    ]);
    expect(meta[2]).toEqual({
      showDaySeparator: false,
      showInactivitySeparator: false,
      isFirstInGroup: false,
      isContinuation: true,
    });
    // The assistant message following the tool block must still group with
    // the prior assistant message — the tool block did NOT advance the
    // grouping anchor.
    expect(meta[3].isFirstInGroup).toBe(false);
  });

  it("treats thinking blocks as continuations", () => {
    const meta = computeGroupingMeta([
      mk({ id: "a1", role: "assistant", agent: "friday", ts: T0 }),
      mk({ id: "th1", role: "thinking", ts: T0 + 1000 }),
    ]);
    expect(meta[1].isContinuation).toBe(true);
    expect(meta[1].isFirstInGroup).toBe(false);
  });

  it("does NOT let a long tool gap suppress an inactivity separator on the next assistant block", () => {
    // The anchor stays at the assistant ts (T0) — the next assistant 2h
    // later should still fire the inactivity separator even though a tool
    // block landed mid-gap.
    const meta = computeGroupingMeta([
      mk({ id: "a1", role: "assistant", agent: "friday", ts: T0 }),
      mk({ id: "t1", role: "tool", ts: T0 + 30 * MIN }),
      mk({ id: "a2", role: "assistant", agent: "friday", ts: T0 + 120 * MIN }),
    ]);
    expect(meta[2].showInactivitySeparator).toBe(true);
    expect(meta[2].isFirstInGroup).toBe(true);
  });

  it("treats mail user blocks as a distinct author per fromAgent", () => {
    const meta = computeGroupingMeta([
      mk({ id: "m1", role: "user", source: "mail", fromAgent: "builder-a", ts: T0 }),
      mk({ id: "m2", role: "user", source: "mail", fromAgent: "builder-a", ts: T0 + 60_000 }),
      mk({ id: "m3", role: "user", source: "mail", fromAgent: "builder-b", ts: T0 + 90_000 }),
      mk({ id: "u1", role: "user", ts: T0 + 100_000 }),
    ]);
    expect(meta[1].isFirstInGroup).toBe(false);
    expect(meta[2].isFirstInGroup).toBe(true);
    expect(meta[3].isFirstInGroup).toBe(true);
  });
});
