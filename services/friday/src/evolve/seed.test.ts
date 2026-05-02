import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../sessions/registry.js", () => ({
  getAgent: vi.fn(),
  registerScheduledAgent: vi.fn(),
}));

vi.mock("../scheduler/scheduler.js", () => ({
  computeNextRun: vi.fn(() => new Date("2026-04-26T04:00:00.000Z")),
}));

vi.mock("../log.js", () => ({
  log: vi.fn(),
}));

import { getAgent, registerScheduledAgent } from "../sessions/registry.js";
import { seedScheduledMetaAgents } from "./seed.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("seedScheduledMetaAgents", () => {
  it("creates both daily and weekly meta agents when missing", () => {
    vi.mocked(getAgent).mockReturnValue(undefined);

    seedScheduledMetaAgents({ cwd: "/tmp/wd" });

    expect(registerScheduledAgent).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(registerScheduledAgent).mock.calls;

    const daily = calls.find((c) => c[0] === "scheduled-meta-daily");
    expect(daily).toBeDefined();
    expect(daily![1]).toEqual({ cron: "0 4 * * *" });
    expect(daily![2]).toContain("friday evolve scan");
    expect(daily![2]).toContain("mail_send");
    expect(daily![2]).toContain("priority=\"urgent\"");

    const weekly = calls.find((c) => c[0] === "scheduled-meta-weekly");
    expect(weekly).toBeDefined();
    expect(weekly![1]).toEqual({ cron: "0 5 * * 0" });
    expect(weekly![2]).toContain("friday evolve cluster");
    expect(weekly![2]).toContain("--since-hours 168");
  });

  it("only seeds the missing one when daily already exists", () => {
    vi.mocked(getAgent).mockImplementation((name: string) => {
      if (name === "scheduled-meta-daily") {
        return {
          type: "scheduled",
          sessionId: null,
          status: "idle",
          createdAt: "2026-04-26T00:00:00.000Z",
          schedule: { cron: "0 4 * * *" },
          taskPrompt: "stale prompt",
          cwd: "/tmp/wd",
          stateDir: "/tmp/state",
          lastRunAt: null,
          nextRunAt: null,
          paused: false,
        };
      }
      return undefined;
    });

    seedScheduledMetaAgents({ cwd: "/tmp/wd" });

    expect(registerScheduledAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(registerScheduledAgent).mock.calls[0][0]).toBe("scheduled-meta-weekly");
  });

  it("swallows registration errors so the daemon keeps booting", () => {
    vi.mocked(getAgent).mockReturnValue(undefined);
    vi.mocked(registerScheduledAgent).mockImplementation(() => {
      throw new Error("registry write failed");
    });

    expect(() => seedScheduledMetaAgents({ cwd: "/tmp/wd" })).not.toThrow();
  });
});
