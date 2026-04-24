import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @friday/shared
const mockRegistry = new Map<string, any>();
let mockTranscriptPath: string | null = null;
let mockInspectResult: any = null;

vi.mock("@friday/shared", () => ({
  AGENTS_PATH: "/fake/.friday/agents.json",
  loadConfig: () => ({
    agent: { workingDirectory: "/fake/working" },
  }),
  resolveTranscriptPath: () => mockTranscriptPath,
  buildInspectResult: vi.fn(async () => mockInspectResult),
  formatInspectPlain: vi.fn((result: any) => `PLAIN:${result.agentName}`),
  tailTranscript: vi.fn(() => ({ stop: vi.fn() })),
  formatTurn: vi.fn((turn: any) => `TURN:${turn.prompt}`),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(() => JSON.stringify(Object.fromEntries(mockRegistry))),
    existsSync: vi.fn((path: string) => {
      if (path === "/fake/.friday/agents.json") return mockRegistry.size > 0;
      return false;
    }),
  };
});

const { inspectCommand } = await import("./inspect.js");
const { buildInspectResult } = await import("@friday/shared");

describe("inspectCommand", () => {
  beforeEach(() => {
    mockRegistry.clear();
    mockTranscriptPath = null;
    mockInspectResult = null;
    vi.clearAllMocks();
  });

  it("exits with error when no agent name given", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as any);
    const mockErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(inspectCommand([])).rejects.toThrow("exit");
    expect(mockErr).toHaveBeenCalledWith(expect.stringContaining("Usage:"));

    mockExit.mockRestore();
    mockErr.mockRestore();
  });

  it("exits with error when agent not found", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as any);
    const mockErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(inspectCommand(["nonexistent"])).rejects.toThrow("exit");
    expect(mockErr).toHaveBeenCalledWith(expect.stringContaining("not found"));

    mockExit.mockRestore();
    mockErr.mockRestore();
  });

  it("calls buildInspectResult and prints plain output", async () => {
    mockRegistry.set("orchestrator", {
      type: "orchestrator",
      sessionId: "sess-1",
      status: "active",
      createdAt: "",
      children: [],
    });
    mockInspectResult = {
      agentName: "orchestrator",
      agentType: "orchestrator",
      status: "active",
      sessionId: "sess-1",
      jsonlPath: "/fake/path.jsonl",
      turns: [{ index: 0, prompt: "hi", response: "hello", toolCalls: [], usage: {}, model: null }],
      totalTurns: 1,
    };

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    await inspectCommand(["orchestrator"]);

    expect(buildInspectResult).toHaveBeenCalledWith(
      "orchestrator",
      expect.objectContaining({ type: "orchestrator" }),
      expect.objectContaining({ lastN: 5, cwdOverride: "/fake/working" })
    );
    expect(mockLog).toHaveBeenCalledWith("PLAIN:orchestrator");

    mockLog.mockRestore();
  });

  it("passes --turns flag correctly", async () => {
    mockRegistry.set("builder-blog", {
      type: "builder",
      parent: "orchestrator",
      sessionId: "sess-2",
      status: "active",
      workspace: "/ws/builder-blog",
      epicId: null,
      createdAt: "",
      children: [],
    });
    mockInspectResult = {
      agentName: "builder-blog",
      agentType: "builder",
      status: "active",
      sessionId: "sess-2",
      jsonlPath: null,
      turns: [],
      totalTurns: 0,
    };

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    await inspectCommand(["builder-blog", "--turns", "10"]);

    expect(buildInspectResult).toHaveBeenCalledWith(
      "builder-blog",
      expect.anything(),
      expect.objectContaining({ lastN: 10 })
    );

    mockLog.mockRestore();
  });

  it("passes --full flag correctly", async () => {
    mockRegistry.set("builder-blog", {
      type: "builder",
      parent: "orchestrator",
      sessionId: "sess-2",
      status: "active",
      workspace: "/ws/builder-blog",
      epicId: null,
      createdAt: "",
      children: [],
    });
    mockInspectResult = {
      agentName: "builder-blog",
      agentType: "builder",
      status: "active",
      sessionId: "sess-2",
      jsonlPath: null,
      turns: [],
      totalTurns: 0,
    };

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    await inspectCommand(["builder-blog", "--full"]);

    expect(buildInspectResult).toHaveBeenCalledWith(
      "builder-blog",
      expect.anything(),
      expect.objectContaining({ full: true })
    );

    mockLog.mockRestore();
  });
});
