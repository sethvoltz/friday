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
  it("creates scheduled-meta-daily when missing", () => {
    vi.mocked(getAgent).mockReturnValue(undefined);

    seedScheduledMetaAgents({ cwd: "/tmp/wd" });

    expect(registerScheduledAgent).toHaveBeenCalledTimes(1);
    const [name, schedule, taskPrompt, cwd] = vi.mocked(registerScheduledAgent).mock.calls[0];
    expect(name).toBe("scheduled-meta-daily");
    expect(schedule).toEqual({ cron: "0 4 * * *" });
    expect(taskPrompt).toContain("friday-evolve scan");
    expect(cwd).toBe("/tmp/wd");
  });

  it("is a no-op when scheduled-meta-daily already exists", () => {
    vi.mocked(getAgent).mockReturnValue({
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
    });

    seedScheduledMetaAgents({ cwd: "/tmp/wd" });

    expect(registerScheduledAgent).not.toHaveBeenCalled();
  });

  it("swallows registration errors so the daemon keeps booting", () => {
    vi.mocked(getAgent).mockReturnValue(undefined);
    vi.mocked(registerScheduledAgent).mockImplementation(() => {
      throw new Error("registry write failed");
    });

    expect(() => seedScheduledMetaAgents({ cwd: "/tmp/wd" })).not.toThrow();
  });
});
