import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordActivity,
  clearActivity,
  getLastActivity,
  runHealthCheck,
  clearNotifications,
  type HealthCheckConfig,
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

import { listAgents } from "../sessions/registry.js";
import { mailSend } from "../comms/mail.js";

const mockListAgents = vi.mocked(listAgents);
const mockMailSend = vi.mocked(mailSend);

function makeConfig(overrides?: Partial<HealthCheckConfig>): HealthCheckConfig {
  return {
    stallThresholdMs: 10 * 60 * 1000,
    intervalMs: 60 * 1000,
    isAgentRunning: () => true,
    ...overrides,
  };
}

describe("activity tracking", () => {
  beforeEach(() => {
    clearActivity("test-agent");
  });

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

describe("runHealthCheck", () => {
  beforeEach(() => {
    clearNotifications();
    clearActivity("builder-test");
    clearActivity("agent-test");
    mockListAgents.mockReturnValue([]);
    mockMailSend.mockClear();
  });

  it("returns no issues for healthy agents", () => {
    mockListAgents.mockReturnValue([
      {
        name: "builder-test",
        entry: { type: "builder", status: "active", parent: "orchestrator" } as any,
      },
    ]);
    recordActivity("builder-test");

    const issues = runHealthCheck(makeConfig());
    expect(issues).toHaveLength(0);
  });

  it("detects crashed agent (loop not running, status active)", () => {
    mockListAgents.mockReturnValue([
      {
        name: "builder-test",
        entry: { type: "builder", status: "active", parent: "orchestrator" } as any,
      },
    ]);

    const issues = runHealthCheck(makeConfig({ isAgentRunning: () => false }));
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("crashed");
    expect(issues[0].agentName).toBe("builder-test");
    expect(mockMailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "orchestrator",
        subject: expect.stringContaining("crashed"),
      })
    );
  });

  it("does not re-notify about same crashed agent", () => {
    mockListAgents.mockReturnValue([
      {
        name: "builder-test",
        entry: { type: "builder", status: "active", parent: "orchestrator" } as any,
      },
    ]);
    const config = makeConfig({ isAgentRunning: () => false });

    runHealthCheck(config);
    mockMailSend.mockClear();
    // Status was updated to idle, so simulate that
    mockListAgents.mockReturnValue([
      {
        name: "builder-test",
        entry: { type: "builder", status: "idle", parent: "orchestrator" } as any,
      },
    ]);
    const issues2 = runHealthCheck(config);
    expect(issues2).toHaveLength(0);
    expect(mockMailSend).not.toHaveBeenCalled();
  });

  it("detects stalled agent (active, loop running, no recent turn)", () => {
    vi.useFakeTimers();
    try {
      mockListAgents.mockReturnValue([
        {
          name: "builder-test",
          entry: { type: "builder", status: "active", parent: "orchestrator" } as any,
        },
      ]);

      // Record activity, then advance time past the stall threshold
      recordActivity("builder-test");
      vi.advanceTimersByTime(15 * 60 * 1000); // 15 minutes later

      const issues = runHealthCheck(makeConfig({ isAgentRunning: () => true }));

      expect(issues).toHaveLength(1);
      expect(issues[0].type).toBe("stalled");
      expect(issues[0].agentName).toBe("builder-test");
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips orchestrator", () => {
    mockListAgents.mockReturnValue([
      {
        name: "orchestrator",
        entry: { type: "orchestrator", status: "active" } as any,
      },
    ]);

    const issues = runHealthCheck(makeConfig({ isAgentRunning: () => false }));
    expect(issues).toHaveLength(0);
  });

  it("skips destroyed agents", () => {
    mockListAgents.mockReturnValue([
      {
        name: "builder-old",
        entry: { type: "builder", status: "destroyed", parent: "orchestrator" } as any,
      },
    ]);

    const issues = runHealthCheck(makeConfig({ isAgentRunning: () => false }));
    expect(issues).toHaveLength(0);
  });

  it("clears stall notification when activity resumes", () => {
    vi.useFakeTimers();
    try {
      const config = makeConfig({ isAgentRunning: () => true });
      mockListAgents.mockReturnValue([
        {
          name: "builder-test",
          entry: { type: "builder", status: "active", parent: "orchestrator" } as any,
        },
      ]);

      // Record activity, advance past threshold → stall detected
      recordActivity("builder-test");
      vi.advanceTimersByTime(15 * 60 * 1000);
      runHealthCheck(config);
      mockMailSend.mockClear();

      // Record fresh activity → stall cleared
      recordActivity("builder-test");
      const issues = runHealthCheck(config);
      expect(issues).toHaveLength(0);

      // Advance again → stall re-detected (re-notified)
      vi.advanceTimersByTime(15 * 60 * 1000);
      const issues2 = runHealthCheck(config);
      expect(issues2).toHaveLength(1);
      expect(mockMailSend).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
