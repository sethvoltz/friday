import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../log.js", () => ({
  log: vi.fn(),
}));

const mockMailEvents = new EventEmitter();
const mockMailCheck = vi.fn().mockReturnValue([]);
vi.mock("./mail.js", () => ({
  mailCheck: (...args: any[]) => mockMailCheck(...args),
  mailEvents: mockMailEvents,
}));

const { startMailPoller, stopMailPoller } = await import("./mail-poller.js");

function makeMessage(id: string, from: string, subject: string, priority: "normal" | "urgent" = "normal") {
  return {
    id,
    from,
    to: "orchestrator",
    subject,
    body: "",
    priority,
    status: "pending" as const,
    createdAt: "2026-04-23T10:00:00Z",
  };
}

describe("mail-poller", () => {
  let mockOnMail: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockOnMail = vi.fn().mockResolvedValue(undefined);
    mockMailCheck.mockReturnValue([]);
  });

  afterEach(() => {
    stopMailPoller();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not call onMail when no pending mail", async () => {
    startMailPoller({ agentName: "orchestrator", onMail: mockOnMail });

    await vi.advanceTimersByTimeAsync(65_000);
    expect(mockOnMail).not.toHaveBeenCalled();
  });

  it("calls onMail instantly on push event", async () => {
    startMailPoller({ agentName: "orchestrator", onMail: mockOnMail });

    mockMailCheck.mockReturnValue([
      makeMessage("friday-abc", "builder-blog", "Plan ready"),
    ]);

    mockMailEvents.emit("mail:orchestrator", "friday-abc");
    await vi.advanceTimersByTimeAsync(0);

    expect(mockOnMail).toHaveBeenCalledTimes(1);
    expect(mockOnMail).toHaveBeenCalledWith({ hasUrgent: false });
  });

  it("calls onMail on fallback poll", async () => {
    mockMailCheck.mockReturnValue([
      makeMessage("friday-abc", "builder-blog", "Plan ready"),
    ]);

    startMailPoller({ agentName: "orchestrator", onMail: mockOnMail });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(mockOnMail).toHaveBeenCalledTimes(1);
    expect(mockOnMail).toHaveBeenCalledWith({ hasUrgent: false });
  });

  it("reports hasUrgent=true when any new message is urgent", async () => {
    mockMailCheck.mockReturnValue([
      makeMessage("friday-xyz", "builder-auth", "Error!", "urgent"),
    ]);

    startMailPoller({ agentName: "orchestrator", onMail: mockOnMail });
    mockMailEvents.emit("mail:orchestrator", "friday-xyz");
    await vi.advanceTimersByTimeAsync(0);

    expect(mockOnMail).toHaveBeenCalledWith({ hasUrgent: true });
  });

  it("reports hasUrgent=true when a batch mixes urgent and normal", async () => {
    mockMailCheck.mockReturnValue([
      makeMessage("friday-1", "a", "normal"),
      makeMessage("friday-2", "b", "urgent!", "urgent"),
    ]);

    startMailPoller({ agentName: "orchestrator", onMail: mockOnMail });
    mockMailEvents.emit("mail:orchestrator", "friday-2");
    await vi.advanceTimersByTimeAsync(0);

    expect(mockOnMail).toHaveBeenCalledWith({ hasUrgent: true });
  });

  it("does not notify twice for the same message", async () => {
    mockMailCheck.mockReturnValue([
      makeMessage("friday-abc", "builder-blog", "Plan ready"),
    ]);

    startMailPoller({ agentName: "orchestrator", onMail: mockOnMail });
    mockMailEvents.emit("mail:orchestrator", "friday-abc");
    await vi.advanceTimersByTimeAsync(0);
    expect(mockOnMail).toHaveBeenCalledTimes(1);

    // Same message still pending — push again should NOT trigger
    mockMailEvents.emit("mail:orchestrator", "friday-abc");
    await vi.advanceTimersByTimeAsync(0);
    expect(mockOnMail).toHaveBeenCalledTimes(1);
  });

  it("notifies again after message is processed and new one arrives", async () => {
    mockMailCheck.mockReturnValue([
      makeMessage("friday-abc", "builder-blog", "Plan ready"),
    ]);

    startMailPoller({ agentName: "orchestrator", onMail: mockOnMail });
    mockMailEvents.emit("mail:orchestrator", "friday-abc");
    await vi.advanceTimersByTimeAsync(0);
    expect(mockOnMail).toHaveBeenCalledTimes(1);

    // msg1 gone (processed), msg2 arrives
    mockMailCheck.mockReturnValue([
      makeMessage("friday-def", "builder-auth", "Done"),
    ]);

    mockMailEvents.emit("mail:orchestrator", "friday-def");
    await vi.advanceTimersByTimeAsync(0);
    expect(mockOnMail).toHaveBeenCalledTimes(2);
    expect(mockOnMail).toHaveBeenLastCalledWith({ hasUrgent: false });
  });

  it("stops on stopMailPoller", async () => {
    mockMailCheck.mockReturnValue([
      makeMessage("friday-abc", "builder-blog", "Test"),
    ]);

    startMailPoller({ agentName: "orchestrator", onMail: mockOnMail });
    stopMailPoller();

    mockMailEvents.emit("mail:orchestrator", "friday-abc");
    await vi.advanceTimersByTimeAsync(65_000);
    expect(mockOnMail).not.toHaveBeenCalled();
  });
});
