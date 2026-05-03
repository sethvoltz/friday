import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordActivity,
  clearActivity,
  getLastActivity,
  runHealthCheck,
  clearNotifications,
  type HealthCheckConfig,
  type AgentStallState,
} from "./agent-health.js";

// Mock dependencies
vi.mock("../sessions/registry.js", () => ({
  listAgents: vi.fn(() => []),
  getAgent: vi.fn(),
  updateAgentStatus: vi.fn(),
}));

vi.mock("../comms/mail.js", () => ({
  mailSend: vi.fn(),
}));

vi.mock("../log.js", () => ({
  log: vi.fn(),
}));

vi.mock("../agent/crash-store.js", () => ({
  getCrashInfo: vi.fn(() => null),
}));

import { listAgents } from "../sessions/registry.js";
import { mailSend } from "../comms/mail.js";
import { log } from "../log.js";
import { getCrashInfo } from "../agent/crash-store.js";

const mockListAgents = vi.mocked(listAgents);
const mockMailSend = vi.mocked(mailSend);
const mockLog = vi.mocked(log);
const mockGetCrashInfo = vi.mocked(getCrashInfo);

function makeConfig(overrides?: Partial<HealthCheckConfig>): HealthCheckConfig {
  return {
    stallThresholdMs: 30_000,
    intervalMs: 60_000,
    isAgentRunning: () => true,
    ...overrides,
  };
}

function makeActiveAgent(name: string) {
  return {
    name,
    entry: { type: "builder" as const, status: "active" as const, parent: "orchestrator" } as any,
  };
}

describe("activity tracking", () => {
  beforeEach(() => clearActivity("test-agent"));

  it("records and retrieves activity", () => {
    expect(getLastActivity("test-agent")).toBeNull();
    recordActivity("test-agent");
    expect(getLastActivity("test-agent")).toBeGreaterThan(0);
  });

  it("clears activity", () => {
    recordActivity("test-agent");
    clearActivity("test-agent");
    expect(getLastActivity("test-agent")).toBeNull();
  });
});

describe("runHealthCheck — crash detection", () => {
  beforeEach(() => {
    clearNotifications();
    mockListAgents.mockReturnValue([]);
    mockMailSend.mockClear();
    mockLog.mockClear();
    mockGetCrashInfo.mockReturnValue(null);
  });

  it("detects crashed agent (loop not running)", () => {
    mockListAgents.mockReturnValue([makeActiveAgent("builder-test")]);
    const issues = runHealthCheck(makeConfig({ isAgentRunning: () => false }));
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("crashed");
    expect(mockMailSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: "orchestrator", subject: expect.stringContaining("crashed") })
    );
  });

  it("does not re-notify for same crashed agent (after status update)", () => {
    mockListAgents.mockReturnValue([makeActiveAgent("builder-test")]);
    const config = makeConfig({ isAgentRunning: () => false });
    runHealthCheck(config);
    mockMailSend.mockClear();

    // Status was updated to idle after crash detection
    mockListAgents.mockReturnValue([{
      name: "builder-test",
      entry: { type: "builder" as const, status: "idle" as const, parent: "orchestrator" } as any,
    }]);
    const issues2 = runHealthCheck(config);
    expect(issues2).toHaveLength(0);
    expect(mockMailSend).not.toHaveBeenCalled();
  });

  it("skips orchestrator", () => {
    mockListAgents.mockReturnValue([{
      name: "orchestrator",
      entry: { type: "orchestrator" as const, status: "active" as const } as any,
    }]);
    const issues = runHealthCheck(makeConfig({ isAgentRunning: () => false }));
    expect(issues).toHaveLength(0);
  });

  it("skips destroyed agents", () => {
    mockListAgents.mockReturnValue([{
      name: "builder-old",
      entry: { type: "builder" as const, status: "destroyed" as const, parent: "orchestrator" } as any,
    }]);
    const issues = runHealthCheck(makeConfig({ isAgentRunning: () => false }));
    expect(issues).toHaveLength(0);
  });
});

describe("runHealthCheck — crash diagnostics", () => {
  beforeEach(() => {
    clearNotifications();
    mockListAgents.mockReturnValue([]);
    mockMailSend.mockClear();
    mockLog.mockClear();
    mockGetCrashInfo.mockReturnValue(null);
  });

  it("attaches exitCode and stderrTail to crashed issue when crash info available", () => {
    mockListAgents.mockReturnValue([makeActiveAgent("builder-test")]);
    mockGetCrashInfo.mockReturnValue({ exitCode: 1, stderrTail: "Error: something went wrong" });

    const issues = runHealthCheck(makeConfig({ isAgentRunning: () => false }));
    expect(issues).toHaveLength(1);
    expect(issues[0].exitCode).toBe(1);
    expect(issues[0].stderrTail).toBe("Error: something went wrong");

    expect(mockMailSend).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Exit code: 1") })
    );
    expect(mockMailSend).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Error: something went wrong") })
    );
    expect(mockLog).toHaveBeenCalledWith(
      "warn",
      "agent_health_crashed",
      expect.objectContaining({ exitCode: 1, stderrTail: "Error: something went wrong" })
    );
  });

  it("omits crash diag fields from mail when no crash info available", () => {
    mockListAgents.mockReturnValue([makeActiveAgent("builder-test")]);
    mockGetCrashInfo.mockReturnValue(null);

    const issues = runHealthCheck(makeConfig({ isAgentRunning: () => false }));
    expect(issues).toHaveLength(1);
    expect(issues[0].exitCode).toBeUndefined();
    expect(issues[0].stderrTail).toBeUndefined();

    expect(mockMailSend).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.not.stringContaining("Exit code:") })
    );
  });
});

describe("runHealthCheck — 3-condition IPC stall detection", () => {
  beforeEach(() => {
    clearNotifications();
    clearActivity("builder-stall");
    mockListAgents.mockReturnValue([makeActiveAgent("builder-stall")]);
    mockMailSend.mockClear();
  });

  function makeStallState(overrides?: Partial<AgentStallState>): AgentStallState {
    return {
      lastChunkAt: Date.now(),
      toolCallActive: false,
      waitingForMail: false,
      queryInFlight: false,
      ...overrides,
    };
  }

  it("flags stall when no chunk + no tool + not waiting for mail beyond threshold", () => {
    vi.useFakeTimers();
    try {
      const staleAt = Date.now() - 60_000; // 60s ago
      const stallState = makeStallState({ lastChunkAt: staleAt });
      const config = makeConfig({
        stallThresholdMs: 30_000,
        getStallState: () => stallState,
      });

      const issues = runHealthCheck(config);
      expect(issues).toHaveLength(1);
      expect(issues[0].type).toBe("stalled");
      expect(mockMailSend).toHaveBeenCalledWith(
        expect.objectContaining({ to: "orchestrator", subject: expect.stringContaining("stalled") })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT flag stall when a tool call is active (slow build scenario)", () => {
    const staleAt = Date.now() - 60_000;
    const stallState = makeStallState({ lastChunkAt: staleAt, toolCallActive: true });
    const config = makeConfig({
      stallThresholdMs: 30_000,
      getStallState: () => stallState,
    });

    const issues = runHealthCheck(config);
    expect(issues).toHaveLength(0);
    expect(mockMailSend).not.toHaveBeenCalled();
  });

  it("does NOT flag stall when agent is waiting for mail (idle scenario)", () => {
    const staleAt = Date.now() - 60_000;
    const stallState = makeStallState({ lastChunkAt: staleAt, waitingForMail: true });
    const config = makeConfig({
      stallThresholdMs: 30_000,
      getStallState: () => stallState,
    });

    const issues = runHealthCheck(config);
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag stall when query is in flight (silent planning phase)", () => {
    const staleAt = Date.now() - 60_000;
    const stallState = makeStallState({ lastChunkAt: staleAt, queryInFlight: true });
    const config = makeConfig({
      stallThresholdMs: 30_000,
      getStallState: () => stallState,
    });

    const issues = runHealthCheck(config);
    expect(issues).toHaveLength(0);
    expect(mockMailSend).not.toHaveBeenCalled();
  });

  it("does NOT flag stall if chunk was recent (under threshold)", () => {
    const stallState = makeStallState({ lastChunkAt: Date.now() - 5_000 }); // 5s ago
    const config = makeConfig({
      stallThresholdMs: 30_000,
      getStallState: () => stallState,
    });

    const issues = runHealthCheck(config);
    expect(issues).toHaveLength(0);
  });

  it("clears stall notification when stall conditions are resolved", () => {
    const staleAt = Date.now() - 60_000;
    const stallState = makeStallState({ lastChunkAt: staleAt });
    const config = makeConfig({
      stallThresholdMs: 30_000,
      getStallState: () => stallState,
    });

    runHealthCheck(config); // stall detected
    mockMailSend.mockClear();

    // Simulate recovery: fresh chunk
    stallState.lastChunkAt = Date.now();
    const issues2 = runHealthCheck(config);
    expect(issues2).toHaveLength(0);

    // Stall again: should re-notify (notification was cleared on recovery)
    stallState.lastChunkAt = Date.now() - 60_000;
    runHealthCheck(config);
    expect(mockMailSend).toHaveBeenCalled();
  });

  it("does not re-notify about the same stall", () => {
    const staleAt = Date.now() - 60_000;
    const stallState = makeStallState({ lastChunkAt: staleAt });
    const config = makeConfig({ stallThresholdMs: 30_000, getStallState: () => stallState });

    runHealthCheck(config); // first notification
    mockMailSend.mockClear();
    runHealthCheck(config); // same stall, should not re-notify
    expect(mockMailSend).not.toHaveBeenCalled();
  });

  it("falls back to last-activity when no stall state available", () => {
    vi.useFakeTimers();
    try {
      const config = makeConfig({
        stallThresholdMs: 30_000,
        getStallState: () => null, // no IPC state
      });

      recordActivity("builder-stall");
      vi.advanceTimersByTime(60_000); // advance past threshold

      const issues = runHealthCheck(config);
      expect(issues).toHaveLength(1);
      expect(issues[0].type).toBe("stalled");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runHealthCheck — startup grace period", () => {
  beforeEach(() => {
    clearNotifications();
    clearActivity("builder-new");
    mockListAgents.mockReturnValue([]);
    mockMailSend.mockClear();
  });

  function makeAgentWithCreatedAt(name: string, createdAt: string) {
    return {
      name,
      entry: {
        type: "builder" as const,
        status: "active" as const,
        parent: "orchestrator",
        createdAt,
      } as any,
    };
  }

  it("does NOT flag a 0-turn agent within the startup grace period", () => {
    vi.useFakeTimers();
    try {
      const createdAt = new Date(Date.now()).toISOString();
      mockListAgents.mockReturnValue([makeAgentWithCreatedAt("builder-new", createdAt)]);

      vi.advanceTimersByTime(20_000); // 20s — within 30s grace
      const issues = runHealthCheck(makeConfig({
        isAgentRunning: () => true,
        startupGracePeriodMs: 30_000,
      }));
      expect(issues).toHaveLength(0);
      expect(mockMailSend).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flags a 0-turn agent after grace period expires, using createdAt as baseline", () => {
    vi.useFakeTimers();
    try {
      const createdAt = new Date(Date.now()).toISOString();
      mockListAgents.mockReturnValue([makeAgentWithCreatedAt("builder-new", createdAt)]);

      vi.advanceTimersByTime(40_000); // 40s — past 30s grace
      const issues = runHealthCheck(makeConfig({
        isAgentRunning: () => true,
        startupGracePeriodMs: 30_000,
      }));
      expect(issues).toHaveLength(1);
      expect(issues[0].type).toBe("stalled");
      expect(issues[0].message).toContain("has not completed any turns since spawning");
      expect(mockMailSend).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("IPC stall state does not fire during grace period even with stale chunk", () => {
    vi.useFakeTimers();
    try {
      const createdAt = new Date(Date.now()).toISOString();
      mockListAgents.mockReturnValue([makeAgentWithCreatedAt("builder-new", createdAt)]);

      // Chunk was 60s stale at spawn time — IPC check alone would fire
      const staleAt = Date.now() - 60_000;
      vi.advanceTimersByTime(20_000); // 20s into grace period

      const stallState: AgentStallState = {
        lastChunkAt: staleAt,
        toolCallActive: false,
        waitingForMail: false,
      };
      const issues = runHealthCheck(makeConfig({
        isAgentRunning: () => true,
        startupGracePeriodMs: 30_000,
        getStallState: () => stallState,
      }));
      expect(issues).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-notify a 0-turn stall while still stalled", () => {
    vi.useFakeTimers();
    try {
      const createdAt = new Date(Date.now()).toISOString();
      mockListAgents.mockReturnValue([makeAgentWithCreatedAt("builder-new", createdAt)]);

      vi.advanceTimersByTime(40_000); // past grace
      runHealthCheck(makeConfig({ isAgentRunning: () => true, startupGracePeriodMs: 30_000 }));
      mockMailSend.mockClear();

      vi.advanceTimersByTime(30_000); // still no turns
      const issues = runHealthCheck(makeConfig({ isAgentRunning: () => true, startupGracePeriodMs: 30_000 }));
      expect(issues).toHaveLength(0);
      expect(mockMailSend).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("1+-turn stall detection still works alongside grace period logic", () => {
    vi.useFakeTimers();
    try {
      const createdAt = new Date(Date.now()).toISOString();
      mockListAgents.mockReturnValue([makeAgentWithCreatedAt("builder-new", createdAt)]);

      recordActivity("builder-new");
      vi.advanceTimersByTime(60_000); // 60s — past stallThresholdMs

      const issues = runHealthCheck(makeConfig({
        isAgentRunning: () => true,
        stallThresholdMs: 30_000,
        getStallState: () => null,
      }));
      expect(issues).toHaveLength(1);
      expect(issues[0].type).toBe("stalled");
      expect(issues[0].message).not.toContain("has not completed any turns");
    } finally {
      vi.useRealTimers();
    }
  });
});
