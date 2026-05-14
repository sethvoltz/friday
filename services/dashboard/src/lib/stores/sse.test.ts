/**
 * SSE-store regression tests.
 *
 * FRI-8: after a daemon restart, a fresh page load (no tab was open during
 * the bounce) was silently rejecting every event from the new daemon
 * process. Persisted `chat.lastSeqByAgent` from the previous daemon held
 * cursors at e.g. 500; the new daemon's ring buffer restarted at seq=1;
 * the dedup check (`event.seq <= cursor`) rejected everything. The
 * boot_id mismatch detector was supposed to catch this — it didn't,
 * because the cached boot_id was module-scoped and reset to `null` on
 * every page reload, so the comparison short-circuited.
 *
 * The fix persists boot_id alongside the cursor and hydrates the cache
 * from localStorage at module load. The mismatch check now fires on the
 * very first connection of a fresh page load when the daemon has cycled
 * underneath.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadJSON = vi.fn();
const mockSaveJSON = vi.fn();
const mockLoadString = vi.fn<(key: string) => string | null>();
const mockSaveString = vi.fn();

vi.mock("$lib/stores/persistent", () => ({
  loadJSON: mockLoadJSON,
  saveJSON: mockSaveJSON,
  loadString: mockLoadString,
  saveString: mockSaveString,
  KEYS: { transcript: (agent: string) => `transcript:${agent}` },
}));

vi.mock("$lib/stores/dashboard-data.svelte", () => ({
  bumpDashboardData: vi.fn(),
}));

vi.mock("$lib/stores/connectivity.svelte", () => ({
  connectivity: { markSuccess: vi.fn() },
}));

// `loadAgentTurns` reaches into the network. Stub it on the chat singleton
// so the cursor-clear path in `acceptConnectionEstablished` doesn't fire a
// real fetch.
const mockLoadAgentTurns = vi.fn(() => Promise.resolve());

beforeEach(() => {
  mockLoadJSON.mockReset();
  mockSaveJSON.mockReset();
  mockLoadString.mockReset();
  mockSaveString.mockReset();
  mockLoadAgentTurns.mockReset();
  mockLoadJSON.mockReturnValue({});
  mockLoadString.mockReturnValue(null);
  vi.resetModules();
});

describe("FRI-8: boot_id mismatch on fresh page load clears stale cursor", () => {
  it("clears chat.lastSeqByAgent when persisted boot_id mismatches the incoming one", async () => {
    // Simulate: previous session connected to daemon "A" and persisted
    // lastSeqByAgent={friday: 500}. Daemon then restarted (now "B").
    // User opens a fresh tab — the module hydrates cachedBootId from
    // localStorage at import time. The first connection_established
    // carries boot_id="B" and must clear the stale cursor.
    mockLoadJSON.mockImplementation((key: string) => {
      if (key === "chat:lastSeqByAgent") return { friday: 500 };
      return {};
    });
    mockLoadString.mockImplementation((key: string) =>
      key === "sse:bootId" ? "boot-A" : null,
    );

    const sse = await import("./sse.svelte");
    const { chat } = await import("./chat.svelte");
    chat.loadAgentTurns = mockLoadAgentTurns as unknown as typeof chat.loadAgentTurns;

    // Sanity: hydrated cursor is present.
    expect(chat.lastSeqByAgent["friday"]).toBe(500);

    sse.acceptConnectionEstablished("boot-B", Date.now());

    // The cursor must be wiped — otherwise the next applyEvent with
    // seq=1 from the fresh daemon would be rejected.
    expect(chat.lastSeqByAgent).toEqual({});
    expect(mockSaveJSON).toHaveBeenCalledWith("chat:lastSeqByAgent", {});
    // The new boot_id must be persisted so a subsequent reload during
    // the same daemon's lifetime sees a match and does NOT clear.
    expect(mockSaveString).toHaveBeenCalledWith("sse:bootId", "boot-B");
    // The focused agent's history must be re-seeded from the canonical
    // blocks endpoint (the in-flight turn lives there now).
    expect(mockLoadAgentTurns).toHaveBeenCalled();

    // The bug: an event with seq=1 from the new daemon must now be
    // accepted by the chat store's dedup. Pin that behavior — the
    // primary user-visible symptom on FRI-8 was that this rejection
    // silently dropped every streaming event.
    chat.focusedAgent = "friday";
    chat.applyEvent({
      v: 1,
      type: "turn_started",
      agent: "friday",
      turn_id: "t-after-restart",
      ts: 1,
      seq: 1,
    } as Parameters<typeof chat.applyEvent>[0]);
    expect(chat.inflightTurnId).toBe("t-after-restart");
  });

  it("does NOT clear when persisted boot_id matches incoming (same daemon, just reconnecting)", async () => {
    mockLoadJSON.mockImplementation((key: string) =>
      key === "chat:lastSeqByAgent" ? { friday: 500 } : {},
    );
    mockLoadString.mockImplementation((key: string) =>
      key === "sse:bootId" ? "boot-A" : null,
    );

    const sse = await import("./sse.svelte");
    const { chat } = await import("./chat.svelte");
    chat.loadAgentTurns = mockLoadAgentTurns as unknown as typeof chat.loadAgentTurns;

    sse.acceptConnectionEstablished("boot-A", Date.now());

    // Same daemon — cursor must be preserved so we keep deduping the
    // ring-buffer replay on reconnect.
    expect(chat.lastSeqByAgent["friday"]).toBe(500);
    expect(mockLoadAgentTurns).not.toHaveBeenCalled();
  });

  it("first connection ever (no persisted boot_id) does not clobber the cursor", async () => {
    // Brand-new install or a user who cleared localStorage. cachedBootId
    // is null AND lastSeqByAgent is empty. No mismatch to detect; the
    // incoming boot_id is just recorded.
    mockLoadJSON.mockReturnValue({});
    mockLoadString.mockReturnValue(null);

    const sse = await import("./sse.svelte");
    const { chat } = await import("./chat.svelte");
    chat.loadAgentTurns = mockLoadAgentTurns as unknown as typeof chat.loadAgentTurns;

    sse.acceptConnectionEstablished("boot-A", Date.now());

    expect(mockLoadAgentTurns).not.toHaveBeenCalled();
    expect(mockSaveString).toHaveBeenCalledWith("sse:bootId", "boot-A");
  });
});
