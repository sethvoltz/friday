import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("../log.js", () => ({ log: vi.fn() }));

// ── Mock DB helpers ───────────────────────────────────────────────────────
// Use importOriginal so path constants (DAEMON_LOG_PATH etc.) are preserved
// while only the DB helpers are mocked.
vi.mock("@friday/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@friday/shared")>();
  return {
    ...actual,
    insertThreadConnection: vi.fn(),
    deleteThreadConnection: vi.fn(),
    getThreadConnectionByAgent: vi.fn(),
    getThreadConnectionByThread: vi.fn(),
    updateThreadActivity: vi.fn(),
    getAllThreadConnections: vi.fn(() => []),
  };
});

import {
  insertThreadConnection,
  deleteThreadConnection,
  updateThreadActivity,
  getAllThreadConnections,
} from "@friday/shared";

// Import after mocking so the module uses the mocked helpers
import {
  connect,
  disconnect,
  getByAgent,
  getByThread,
  touchActivity,
  initThreadRegistry,
  setPendingReaction,
  clearPendingReaction,
} from "./thread-registry.js";

// ── Helpers ───────────────────────────────────────────────────────────────

/** Clear in-memory state between tests by re-initialising with empty DB */
function resetRegistry() {
  (getAllThreadConnections as Mock).mockReturnValue([]);
  initThreadRegistry({ onIdleDisconnect: vi.fn() });
}

describe("thread-registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── connect ──────────────────────────────────────────────────────────

  it("connect: inserts row and updates in-memory maps", () => {
    const result = connect("builder-foo", "C001", "111.222");

    expect(result.ok).toBe(true);
    expect(insertThreadConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "builder-foo",
        channelId: "C001",
        threadTs: "111.222",
      })
    );

    expect(getByAgent("builder-foo")).toMatchObject({ agentName: "builder-foo" });
    expect(getByThread("111.222")).toMatchObject({ agentName: "builder-foo" });
  });

  it("connect: returns error when thread is already owned by a different agent", () => {
    connect("builder-a", "C001", "111.222");
    const result = connect("builder-b", "C001", "111.222");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/builder-a/);
    }
  });

  it("connect: stolen — disconnects old thread when agent connects to new thread", () => {
    connect("builder-a", "C001", "111.222");
    const result = connect("builder-a", "C001", "333.444");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stolen).toMatchObject({ agentName: "builder-a", threadTs: "111.222" });
    }
    // Old thread gone, new thread present
    expect(getByThread("111.222")).toBeUndefined();
    expect(getByThread("333.444")).toMatchObject({ agentName: "builder-a" });
    expect(deleteThreadConnection).toHaveBeenCalledWith("builder-a");
    // insertThreadConnection called twice (original + new)
    expect(insertThreadConnection).toHaveBeenCalledTimes(2);
  });

  // ── disconnect ───────────────────────────────────────────────────────

  it("disconnect: removes row and clears maps", () => {
    connect("builder-foo", "C001", "111.222");
    const result = disconnect("builder-foo", "manual");

    expect(result).toMatchObject({ agentName: "builder-foo", threadTs: "111.222" });
    expect(deleteThreadConnection).toHaveBeenCalledWith("builder-foo");
    expect(getByAgent("builder-foo")).toBeUndefined();
    expect(getByThread("111.222")).toBeUndefined();
  });

  it("disconnect: returns null when agent not connected", () => {
    expect(disconnect("builder-none", "manual")).toBeNull();
  });

  // ── getByAgent / getByThread ─────────────────────────────────────────

  it("getByAgent: returns undefined before connect", () => {
    expect(getByAgent("builder-missing")).toBeUndefined();
  });

  it("getByThread: returns connection after connect, undefined after disconnect", () => {
    connect("builder-foo", "C001", "111.222");
    expect(getByThread("111.222")).toBeDefined();
    disconnect("builder-foo", "manual");
    expect(getByThread("111.222")).toBeUndefined();
  });

  // ── touchActivity ────────────────────────────────────────────────────

  it("touchActivity: updates last_activity_at in SQLite", () => {
    connect("builder-foo", "C001", "111.222");
    vi.advanceTimersByTime(1000);
    touchActivity("builder-foo");

    expect(updateThreadActivity).toHaveBeenCalledWith("builder-foo", expect.any(Number));
  });

  it("touchActivity: is a no-op when agent not connected", () => {
    touchActivity("builder-gone");
    expect(updateThreadActivity).not.toHaveBeenCalled();
  });

  // ── idle timer ───────────────────────────────────────────────────────

  it("idle timer: fires after 2 hours and calls onIdleDisconnect", () => {
    const onIdleDisconnect = vi.fn();
    initThreadRegistry({ onIdleDisconnect });

    connect("builder-foo", "C001", "111.222");

    vi.advanceTimersByTime(7_200_000);

    expect(onIdleDisconnect).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: "builder-foo" })
    );
    expect(getByAgent("builder-foo")).toBeUndefined();
  });

  // ── initThreadRegistry ───────────────────────────────────────────────

  it("initThreadRegistry: prunes expired rows silently", () => {
    const now = Date.now();
    (getAllThreadConnections as Mock).mockReturnValue([
      {
        agentName: "builder-old",
        channelId: "C001",
        threadTs: "111.222",
        lastActivityAt: now - 8_000_000, // > 2h ago
        createdAt: now - 8_000_000,
      },
    ]);

    initThreadRegistry({ onIdleDisconnect: vi.fn() });

    expect(deleteThreadConnection).toHaveBeenCalledWith("builder-old");
    expect(getByAgent("builder-old")).toBeUndefined();
  });

  it("initThreadRegistry: restores live connections with maps populated", () => {
    const now = Date.now();
    (getAllThreadConnections as Mock).mockReturnValue([
      {
        agentName: "builder-live",
        channelId: "C002",
        threadTs: "222.333",
        lastActivityAt: now - 1_000_000, // ~16 min ago — still live
        createdAt: now - 1_000_000,
      },
    ]);

    initThreadRegistry({ onIdleDisconnect: vi.fn() });

    expect(getByAgent("builder-live")).toMatchObject({ agentName: "builder-live" });
    expect(getByThread("222.333")).toMatchObject({ agentName: "builder-live" });
    expect(deleteThreadConnection).not.toHaveBeenCalled();
  });

  // ── pendingReaction ──────────────────────────────────────────────────

  it("setPendingReaction: stores reaction on connected agent", () => {
    connect("builder-foo", "C001", "111.222");
    setPendingReaction("builder-foo", "C001", "ts-abc", "eyes");
    const conn = getByAgent("builder-foo");
    expect(conn?.pendingReaction).toEqual({ channelId: "C001", messageTs: "ts-abc", emojiName: "eyes" });
  });

  it("clearPendingReaction: returns and removes the pending reaction", () => {
    connect("builder-foo", "C001", "111.222");
    setPendingReaction("builder-foo", "C001", "ts-abc", "eyes");
    const pending = clearPendingReaction("builder-foo");
    expect(pending).toEqual({ channelId: "C001", messageTs: "ts-abc", emojiName: "eyes" });
    expect(getByAgent("builder-foo")?.pendingReaction).toBeUndefined();
  });

  it("clearPendingReaction: returns undefined when no reaction is pending", () => {
    connect("builder-foo", "C001", "111.222");
    expect(clearPendingReaction("builder-foo")).toBeUndefined();
  });

  it("clearPendingReaction: returns undefined when agent is not connected", () => {
    expect(clearPendingReaction("nobody")).toBeUndefined();
  });

  it("setPendingReaction: is a no-op when agent is not connected", () => {
    setPendingReaction("nobody", "C001", "ts-abc", "eyes");
    // Should not throw
  });

  it("initThreadRegistry: restored connection fires idle timer with remaining time", () => {
    const onIdleDisconnect = vi.fn();
    const now = Date.now();
    const elapsed = 3_600_000; // 1 hour elapsed
    (getAllThreadConnections as Mock).mockReturnValue([
      {
        agentName: "builder-half",
        channelId: "C003",
        threadTs: "333.444",
        lastActivityAt: now - elapsed,
        createdAt: now - elapsed,
      },
    ]);

    initThreadRegistry({ onIdleDisconnect });

    // Should fire after the remaining ~1h, not after 2h
    vi.advanceTimersByTime(3_600_000); // advance remaining 1h
    expect(onIdleDisconnect).toHaveBeenCalled();
  });
});
