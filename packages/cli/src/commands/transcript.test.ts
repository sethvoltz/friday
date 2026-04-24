import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRegistry = new Map<string, any>();
let mockInspectResult: any = null;

vi.mock("@friday/shared", () => ({
  AGENTS_PATH: "/fake/.friday/agents.json",
  loadConfig: () => ({
    agent: { workingDirectory: "/fake/working" },
  }),
  buildInspectResult: vi.fn(async () => mockInspectResult),
  formatInspectMarkdown: vi.fn((result: any) => `# Transcript: ${result.agentName}\n\nMarkdown content`),
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
    writeFileSync: vi.fn(),
  };
});

const { transcriptCommand } = await import("./transcript.js");
const { buildInspectResult, formatInspectMarkdown } = await import("@friday/shared");
const { writeFileSync } = await import("node:fs");

describe("transcriptCommand", () => {
  beforeEach(() => {
    mockRegistry.clear();
    mockInspectResult = null;
    vi.clearAllMocks();
  });

  it("exits with error when no agent name given", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as any);
    const mockErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(transcriptCommand([])).rejects.toThrow("exit");
    expect(mockErr).toHaveBeenCalledWith(expect.stringContaining("Usage:"));

    mockExit.mockRestore();
    mockErr.mockRestore();
  });

  it("prints markdown to stdout by default", async () => {
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
      jsonlPath: null,
      turns: [],
      totalTurns: 0,
    };

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    await transcriptCommand(["orchestrator"]);

    expect(buildInspectResult).toHaveBeenCalledWith(
      "orchestrator",
      expect.objectContaining({ type: "orchestrator" }),
      expect.objectContaining({ full: true, includeTools: true, cwdOverride: "/fake/working" })
    );
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("# Transcript: orchestrator"));

    mockLog.mockRestore();
  });

  it("writes to file with --output flag", async () => {
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
    await transcriptCommand(["builder-blog", "--output", "/tmp/out.md"]);

    expect(writeFileSync).toHaveBeenCalledWith("/tmp/out.md", expect.stringContaining("# Transcript: builder-blog"));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("/tmp/out.md"));

    mockLog.mockRestore();
  });
});
