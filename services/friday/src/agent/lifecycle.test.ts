/**
 * lifecycle.test.ts — fork-based supervisor tests
 *
 * These tests exercise the lifecycle.ts supervisor (fork/kill/refork) using
 * mock ChildProcess objects so the tests are fast and deterministic. We don't
 * mock fork() to a no-op — each MockChildProcess behaves like a real process
 * (emits "exit", handles SIGKILL vs. SIGTERM differently, etc.).
 *
 * What's NOT tested here (covered in worker.ts and integration):
 *  - Claude SDK query loop
 *  - IPC protocol correctness
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { WorkerCommand, WorkerEvent } from "./worker-protocol.js";

// ── Mock ChildProcess factory ─────────────────────────────────────────────

class MockChildProcess extends EventEmitter {
  pid: number;
  connected: boolean = true;
  _killSignals: string[] = [];
  _sentMessages: WorkerCommand[] = [];
  private _ignoreTerminate: boolean;

  constructor(pid: number, opts: { ignoreTerminate?: boolean } = {}) {
    super();
    this.pid = pid;
    this._ignoreTerminate = opts.ignoreTerminate ?? false;
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this._killSignals.push(String(signal));
    if (signal === "SIGKILL" || (!this._ignoreTerminate && signal === "SIGTERM")) {
      // Emit exit asynchronously (like a real process)
      setImmediate(() => {
        this.connected = false;
        this.emit("exit", null, String(signal));
      });
    }
    return true;
  }

  send(msg: WorkerCommand): boolean {
    this._sentMessages.push(msg);
    return true;
  }

  /** Simulate the worker emitting an IPC event */
  simulateEvent(event: WorkerEvent): void {
    this.emit("message", event);
  }

  once(event: string, handler: (...args: any[]) => void): this {
    return super.once(event, handler);
  }
}

// ── Mocks ──────────────────────────────────────────────────────────────────

let mockProcesses: MockChildProcess[] = [];
let nextPid = 1000;

vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const child = new MockChildProcess(nextPid++);
    mockProcesses.push(child);
    return child as unknown as ChildProcess;
  }),
}));

vi.mock("../comms/mail.js", () => ({
  mailEvents: new EventEmitter(),
  mailSend: vi.fn(),
}));

vi.mock("./prime.js", () => ({
  buildAgentSystemPrompt: vi.fn(() => "system prompt"),
  buildFirstTurnPrompt: vi.fn(() => "first turn prompt"),
}));

vi.mock("./workspace.js", () => ({
  createWorkspace: vi.fn(() => ({ path: "/tmp/test-workspace", worktrees: [] })),
  destroyWorkspace: vi.fn(),
}));

const mockRegistry = {
  registerBuilder: vi.fn(),
  registerHelper: vi.fn(),
  registerOrchestrator: vi.fn(),
  updateAgentSession: vi.fn(),
  updateAgentStatus: vi.fn(),
  destroyAgent: vi.fn(),
  getAgent: vi.fn(),
  listAgents: vi.fn(() => []),
};
vi.mock("../sessions/registry.js", () => mockRegistry);

vi.mock("../monitor/usage.js", () => ({ logUsage: vi.fn() }));
vi.mock("../monitor/agent-health.js", () => ({
  recordActivity: vi.fn(),
  clearActivity: vi.fn(),
}));
vi.mock("../monitor/file-tracker.js", () => ({
  recordTurnFiles: vi.fn(),
  clearFileTracking: vi.fn(),
}));
vi.mock("../events/bus.js", () => ({
  eventBus: { publish: vi.fn() },
}));
vi.mock("../log.js", () => ({ log: vi.fn() }));

// ── Import under test ──────────────────────────────────────────────────────

const {
  createBuilder,
  createHelper,
  killAgentByName,
  destroyAgentByName,
  reforkAgentByName,
  isAgentRunning,
  getAgentStallState,
  restoreActiveAgents,
  killAllAgents,
} = await import("./lifecycle.js");

const { mailEvents } = await import("../comms/mail.js");

// ── Helpers ────────────────────────────────────────────────────────────────

function spawnBuilder(name: string): MockChildProcess {
  createBuilder({
    name,
    workingDirectory: "/work",
    repos: [],
    epicId: null,
    model: "claude-test",
  });
  return mockProcesses[mockProcesses.length - 1];
}

function spawnHelper(name: string, parent = "orchestrator"): MockChildProcess {
  createHelper({
    name,
    parent,
    taskId: null,
    cwd: "/tmp/helper",
    model: "claude-test",
  });
  return mockProcesses[mockProcesses.length - 1];
}

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockProcesses = [];
  nextPid = 1000;
  vi.clearAllMocks();
  // Default: getAgent returns null (agent not in registry initially)
  mockRegistry.getAgent.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createBuilder — process spawn", () => {
  it("forks a child process and marks agent as running", async () => {
    const child = spawnBuilder("builder-fork-test");
    expect(child).toBeDefined();
    expect(child.pid).toBeGreaterThan(0);
    expect(isAgentRunning("builder-fork-test")).toBe(true);
  });

  it("sends start command to forked worker", async () => {
    spawnBuilder("builder-start-cmd");
    const child = mockProcesses[mockProcesses.length - 1];
    expect(child._sentMessages).toHaveLength(1);
    expect(child._sentMessages[0]).toMatchObject({
      type: "start",
      options: { agentName: "builder-start-cmd", agentType: "builder" },
    });
  });

  it("registers the builder in the registry", async () => {
    spawnBuilder("builder-registered");
    expect(mockRegistry.registerBuilder).toHaveBeenCalledWith(
      "builder-registered",
      "orchestrator",
      "/tmp/test-workspace",
      null
    );
  });
});

describe("createHelper — process spawn", () => {
  it("forks a child process for the helper", async () => {
    spawnHelper("helper-spawn-test");
    expect(isAgentRunning("helper-spawn-test")).toBe(true);
  });

  it("registers the helper with parent reference", async () => {
    spawnHelper("helper-with-parent", "builder-parent");
    expect(mockRegistry.registerHelper).toHaveBeenCalledWith(
      "helper-with-parent",
      "builder-parent",
      null,
      "/tmp/helper"
    );
  });
});

const builderEntry = { type: "builder" as const, status: "active" as const, workspace: "/tmp/ws" };

describe("killAgentByName — immediate SIGKILL", () => {
  it("sends SIGKILL to the process", async () => {
    spawnBuilder("builder-kill-target");
    mockRegistry.getAgent.mockReturnValue(builderEntry);
    killAgentByName("builder-kill-target");
    const child = mockProcesses[mockProcesses.length - 1];
    expect(child._killSignals).toContain("SIGKILL");
  });

  it("removes the agent from the running map immediately", async () => {
    spawnBuilder("builder-kill-gone");
    expect(isAgentRunning("builder-kill-gone")).toBe(true);
    mockRegistry.getAgent.mockReturnValue(builderEntry);
    killAgentByName("builder-kill-gone");
    expect(isAgentRunning("builder-kill-gone")).toBe(false);
  });

  it("updates agent status to idle after kill", async () => {
    spawnBuilder("builder-kill-status");
    mockRegistry.getAgent.mockReturnValue(builderEntry);
    killAgentByName("builder-kill-status");
    expect(mockRegistry.updateAgentStatus).toHaveBeenCalledWith("builder-kill-status", "idle");
  });

  it("does not affect other running agents", async () => {
    spawnBuilder("builder-target");
    spawnBuilder("builder-innocent");
    mockRegistry.getAgent.mockReturnValue(builderEntry);

    killAgentByName("builder-target");

    expect(isAgentRunning("builder-target")).toBe(false);
    expect(isAgentRunning("builder-innocent")).toBe(true);
  });

  it("throws if agent name not found in registry", async () => {
    mockRegistry.getAgent.mockReturnValue(null);
    expect(() => killAgentByName("nonexistent")).toThrow(/not found/);
  });

  it("throws if trying to kill the orchestrator", async () => {
    mockRegistry.getAgent.mockReturnValue({ type: "orchestrator", status: "active" });
    expect(() => killAgentByName("orchestrator")).toThrow(/Cannot kill the Orchestrator/);
  });
});

describe("destroyAgentByName — graceful shutdown with SIGKILL fallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("sends SIGTERM first", async () => {
    spawnBuilder("builder-graceful");
    mockRegistry.getAgent.mockReturnValue(builderEntry);
    destroyAgentByName("builder-graceful");
    const child = mockProcesses[mockProcesses.length - 1];
    expect(child._killSignals).toContain("SIGTERM");
  });

  it("sends SIGKILL after 5s if process does not exit", async () => {
    // Create a process that ignores SIGTERM (doesn't emit "exit")
    vi.mocked(await import("node:child_process")).fork.mockImplementationOnce(() => {
      const child = new MockChildProcess(nextPid++, { ignoreTerminate: true });
      mockProcesses.push(child);
      return child as unknown as ChildProcess;
    });

    spawnBuilder("builder-stubborn");
    mockRegistry.getAgent.mockReturnValue(builderEntry);
    destroyAgentByName("builder-stubborn");

    const child = mockProcesses[mockProcesses.length - 1];
    expect(child._killSignals).toContain("SIGTERM");
    expect(child._killSignals).not.toContain("SIGKILL");

    // Advance past 5s grace period
    await vi.advanceTimersByTimeAsync(5_001);

    expect(child._killSignals).toContain("SIGKILL");
  });

  it("cancels SIGKILL if process exits cleanly within 5s", async () => {
    spawnBuilder("builder-clean-exit");
    mockRegistry.getAgent.mockReturnValue(builderEntry);
    destroyAgentByName("builder-clean-exit");

    // Process emits exit immediately on SIGTERM (default MockChildProcess behavior)
    await vi.advanceTimersByTimeAsync(100);

    // Advance past 5s — SIGKILL should NOT have been sent
    await vi.advanceTimersByTimeAsync(5_000);

    const child = mockProcesses[mockProcesses.length - 1];
    expect(child._killSignals).toContain("SIGTERM");
    // SIGKILL should not appear (timer was cleared)
    const sigkillCount = child._killSignals.filter((s) => s === "SIGKILL").length;
    expect(sigkillCount).toBe(0);
  });

  it("removes agent from registry after destroy", async () => {
    spawnBuilder("builder-deregister");
    mockRegistry.getAgent.mockReturnValue(builderEntry);
    destroyAgentByName("builder-deregister");
    expect(mockRegistry.destroyAgent).toHaveBeenCalledWith("builder-deregister");
  });
});

describe("reforkAgentByName — non-destructive restart", () => {
  it("kills existing process and spawns a new one", async () => {
    spawnBuilder("builder-refork");
    const originalChild = mockProcesses[mockProcesses.length - 1];

    mockRegistry.getAgent.mockReturnValue({
      type: "builder", status: "active", sessionId: "sess-abc", workspace: "/tmp/ws",
    });
    reforkAgentByName("builder-refork");

    const newChild = mockProcesses[mockProcesses.length - 1];
    expect(newChild).not.toBe(originalChild);
    expect(originalChild._killSignals).toContain("SIGKILL");
  });

  it("new process receives start command with resume session ID", async () => {
    spawnBuilder("builder-refork-resume");

    mockRegistry.getAgent.mockReturnValue({
      type: "builder", status: "idle", sessionId: "sess-resume-xyz", workspace: "/tmp/ws",
    });
    reforkAgentByName("builder-refork-resume");

    const newChild = mockProcesses[mockProcesses.length - 1];
    const startCmd = newChild._sentMessages.find((m) => m.type === "start");
    expect(startCmd).toBeDefined();
    expect((startCmd as any).options.resumeSessionId).toBe("sess-resume-xyz");
  });

  it("agent is running again after refork", async () => {
    spawnBuilder("builder-refork-running");

    mockRegistry.getAgent.mockReturnValue({
      type: "builder", status: "active", sessionId: "sess-abc", workspace: "/tmp/ws",
    });
    reforkAgentByName("builder-refork-running");
    expect(isAgentRunning("builder-refork-running")).toBe(true);
  });
});

describe("worker process exit handling", () => {
  it("removes agent from running map when process exits unexpectedly", async () => {
    spawnBuilder("builder-crash-exit");
    expect(isAgentRunning("builder-crash-exit")).toBe(true);

    const child = mockProcesses[mockProcesses.length - 1];
    mockRegistry.getAgent.mockReturnValue({ type: "builder", status: "active" });
    child.emit("exit", 1, null);

    expect(isAgentRunning("builder-crash-exit")).toBe(false);
  });

  it("marks agent as idle when process exits while status is active", async () => {
    spawnBuilder("builder-exit-idle");

    const child = mockProcesses[mockProcesses.length - 1];
    mockRegistry.getAgent.mockReturnValue({ type: "builder", status: "active" });
    child.emit("exit", 0, null);

    expect(mockRegistry.updateAgentStatus).toHaveBeenCalledWith("builder-exit-idle", "idle");
  });
});

describe("stall state tracking via IPC events", () => {
  it("returns null stall state for non-running agent", () => {
    expect(getAgentStallState("ghost-agent")).toBeNull();
  });

  it("initialises stall state on fork", async () => {
    mockRegistry.getAgent.mockReturnValue(null);
    spawnBuilder("builder-stall-init");
    const state = getAgentStallState("builder-stall-init");
    expect(state).not.toBeNull();
    expect(state!.toolCallActive).toBe(false);
    expect(state!.waitingForMail).toBe(false);
    expect(state!.lastChunkAt).toBeGreaterThan(0);
  });

  it("updates lastChunkAt on chunk-received event", async () => {
    mockRegistry.getAgent.mockReturnValue(null);
    spawnBuilder("builder-chunk-event");
    const child = mockProcesses[mockProcesses.length - 1];

    const before = getAgentStallState("builder-chunk-event")!.lastChunkAt;
    await new Promise((r) => setTimeout(r, 5)); // small delay

    child.simulateEvent({ type: "chunk-received" });
    const after = getAgentStallState("builder-chunk-event")!.lastChunkAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("sets toolCallActive=true on tool-start, false on tool-end", async () => {
    mockRegistry.getAgent.mockReturnValue(null);
    spawnBuilder("builder-tool-tracking");
    const child = mockProcesses[mockProcesses.length - 1];

    child.simulateEvent({ type: "tool-start", toolName: "Bash" });
    expect(getAgentStallState("builder-tool-tracking")!.toolCallActive).toBe(true);

    child.simulateEvent({ type: "tool-end", toolName: "Bash" });
    expect(getAgentStallState("builder-tool-tracking")!.toolCallActive).toBe(false);
  });

  it("sets waitingForMail=true on mail-sent event", async () => {
    mockRegistry.getAgent.mockReturnValue(null);
    spawnBuilder("builder-mail-wait");
    const child = mockProcesses[mockProcesses.length - 1];

    child.simulateEvent({ type: "mail-sent" });
    expect(getAgentStallState("builder-mail-wait")!.waitingForMail).toBe(true);
  });

  it("clears waitingForMail on status-change active", async () => {
    mockRegistry.getAgent.mockReturnValue(null);
    spawnBuilder("builder-status-change");
    const child = mockProcesses[mockProcesses.length - 1];

    child.simulateEvent({ type: "mail-sent" });
    expect(getAgentStallState("builder-status-change")!.waitingForMail).toBe(true);

    child.simulateEvent({ type: "status-change", status: "active" });
    expect(getAgentStallState("builder-status-change")!.waitingForMail).toBe(false);
  });
});

describe("IPC-driven registry writes — parent is the sole writer", () => {
  it("persists sessionId to the registry on session-update event", async () => {
    mockRegistry.getAgent.mockReturnValue(null);
    spawnBuilder("builder-session-persist");
    const child = mockProcesses[mockProcesses.length - 1];

    child.simulateEvent({ type: "session-update", sessionId: "sess-from-worker" });

    expect(mockRegistry.updateAgentSession).toHaveBeenCalledWith(
      "builder-session-persist",
      "sess-from-worker"
    );
  });

  it("persists status changes to the registry on status-change event", async () => {
    mockRegistry.getAgent.mockReturnValue(null);
    spawnBuilder("builder-status-persist");
    const child = mockProcesses[mockProcesses.length - 1];

    child.simulateEvent({ type: "status-change", status: "idle" });

    expect(mockRegistry.updateAgentStatus).toHaveBeenCalledWith(
      "builder-status-persist",
      "idle"
    );
  });
});

describe("mail forwarding", () => {
  it("forwards mail-wakeup event to child worker via IPC", async () => {
    mockRegistry.getAgent.mockReturnValue(null);
    spawnHelper("helper-mail-fwd");
    const child = mockProcesses[mockProcesses.length - 1];

    mailEvents.emit("mail:helper-mail-fwd");

    const wakeup = child._sentMessages.find((m) => m.type === "mail-wakeup");
    expect(wakeup).toBeDefined();
  });
});

describe("restoreActiveAgents — daemon restart", () => {
  it("re-forks active agents from registry on daemon restart", async () => {
    mockRegistry.listAgents.mockImplementation((filter?: any) => {
      if (filter?.status === "active") {
        return [{
          name: "builder-restored",
          entry: {
            type: "builder",
            status: "active",
            sessionId: "sess-old-123",
            workspace: "/tmp/restored-ws",
            epicId: null,
            parent: "orchestrator",
            createdAt: "2026-01-01T00:00:00Z",
          },
        }];
      }
      return [];
    });

    restoreActiveAgents("claude-test");

    expect(isAgentRunning("builder-restored")).toBe(true);
    const child = mockProcesses[mockProcesses.length - 1];
    const startCmd = child._sentMessages.find((m) => m.type === "start");
    expect((startCmd as any).options.resumeSessionId).toBe("sess-old-123");
  });

  it("skips orchestrator during restore", async () => {
    const initialForkCount = mockProcesses.length;
    mockRegistry.listAgents.mockImplementation((filter?: any) => {
      if (filter?.status === "active") {
        return [{
          name: "orchestrator",
          entry: { type: "orchestrator", status: "active", createdAt: "2026-01-01T00:00:00Z" },
        }];
      }
      return [];
    });

    restoreActiveAgents("claude-test");

    expect(mockProcesses.length).toBe(initialForkCount); // no new forks
  });

  it("marks agent idle and skips if no sessionId", async () => {
    mockRegistry.listAgents.mockImplementation((filter?: any) => {
      if (filter?.status === "active") {
        return [{
          name: "builder-no-session",
          entry: {
            type: "builder",
            status: "active",
            sessionId: null,
            workspace: "/tmp/ws",
            epicId: null,
            parent: "orchestrator",
            createdAt: "2026-01-01T00:00:00Z",
          },
        }];
      }
      return [];
    });

    const initialForkCount = mockProcesses.length;
    restoreActiveAgents("claude-test");

    expect(mockProcesses.length).toBe(initialForkCount);
    expect(mockRegistry.updateAgentStatus).toHaveBeenCalledWith("builder-no-session", "idle");
  });
});

describe("killAllAgents — daemon shutdown", () => {
  it("sends SIGTERM to all running agents", async () => {
    spawnBuilder("builder-shutdown-a");
    spawnBuilder("builder-shutdown-b");
    const processes = mockProcesses.slice(-2);

    killAllAgents(5_000);

    for (const child of processes) {
      expect(child._killSignals).toContain("SIGTERM");
    }
  });

  it("resolves immediately when no agents are running", async () => {
    await expect(killAllAgents(5_000)).resolves.toBeUndefined();
  });

  it("removes all agents from the running map", async () => {
    spawnBuilder("builder-shutdown-c");
    spawnBuilder("builder-shutdown-d");

    await killAllAgents(100);

    expect(isAgentRunning("builder-shutdown-c")).toBe(false);
    expect(isAgentRunning("builder-shutdown-d")).toBe(false);
  });
});

