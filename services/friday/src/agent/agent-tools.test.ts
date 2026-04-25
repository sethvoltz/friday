import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture tool handlers when createSdkMcpServer is called
const capturedTools = new Map<string, Function>();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn(({ tools }: { tools: any[] }) => {
    capturedTools.clear();
    for (const t of tools) {
      capturedTools.set(t._name, t._handler);
    }
    return { type: "sdk", name: "friday-agents" };
  }),
  tool: vi.fn(
    (name: string, _desc: string, _schema: any, handler: Function) => ({
      _name: name,
      _handler: handler,
    })
  ),
}));

vi.mock("../sessions/registry.js", () => ({
  getAgent: vi.fn(),
  listAgents: vi.fn(() => []),
}));

vi.mock("./lifecycle.js", () => ({
  createBuilder: vi.fn(async () => ({ workspace: "/tmp/ws/builder-test" })),
  createHelper: vi.fn(async () => {}),
  destroyAgentByName: vi.fn(),
  isAgentRunning: vi.fn(() => false),
}));

vi.mock("./workspace.js", () => ({
  addWorktreeToWorkspace: vi.fn(() => ({
    name: "my-repo",
    path: "/tmp/ws/builder-test/my-repo",
    branch: "friday/builder-test",
    source: "local",
  })),
  removeWorktreeFromWorkspace: vi.fn(),
}));

vi.mock("../log.js", () => ({ log: vi.fn() }));

import { createAgentTools } from "./agent-tools.js";
import { getAgent, listAgents } from "../sessions/registry.js";
import {
  createBuilder,
  createHelper,
  destroyAgentByName,
  isAgentRunning,
} from "./lifecycle.js";
import {
  addWorktreeToWorkspace,
  removeWorktreeFromWorkspace,
} from "./workspace.js";

async function callTool(name: string, args: Record<string, any>) {
  const handler = capturedTools.get(name);
  if (!handler) throw new Error(`Tool "${name}" not captured`);
  return handler(args);
}

function orchestratorCtx() {
  return {
    callerName: "orchestrator",
    callerType: "orchestrator" as const,
    workingDirectory: "/tmp/working",
    model: "claude-sonnet-4-20250514",
  };
}

function builderCtx() {
  return {
    callerName: "builder-auth",
    callerType: "builder" as const,
    workingDirectory: "/tmp/working",
    model: "claude-sonnet-4-20250514",
  };
}

describe("createAgentTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-create tools to capture handlers fresh
    createAgentTools(orchestratorCtx());
  });

  it("creates an MCP server", () => {
    const server = createAgentTools(orchestratorCtx());
    expect(server).toBeDefined();
    expect(server.type).toBe("sdk");
  });

  describe("agent_create", () => {
    it("orchestrator can create a builder", async () => {
      createAgentTools(orchestratorCtx());
      const result = await callTool("agent_create", {
        type: "builder",
        name: "builder-api",
        repos: [{ repo: "/tmp/my-repo" }],
        epic_id: "bd-123",
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("builder-api");
      expect(createBuilder).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "builder-api",
          epicId: "bd-123",
          repos: [{ repo: "/tmp/my-repo" }],
        })
      );
    });

    it("builder cannot create a builder", async () => {
      createAgentTools(builderCtx());
      const result = await callTool("agent_create", {
        type: "builder",
        name: "builder-other",
        repos: [{ repo: "/tmp/repo" }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Only the Orchestrator");
    });

    it("builder requires repos", async () => {
      createAgentTools(orchestratorCtx());
      const result = await callTool("agent_create", {
        type: "builder",
        name: "builder-empty",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("require at least one repo");
    });

    it("orchestrator can create a helper", async () => {
      vi.mocked(getAgent).mockReturnValue(undefined);
      createAgentTools(orchestratorCtx());
      const result = await callTool("agent_create", {
        type: "helper",
        name: "helper-lint",
        task_id: "bd-456",
        cwd: "/tmp/ws/builder-auth",
      });

      expect(result.isError).toBeUndefined();
      expect(createHelper).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "helper-lint",
          parent: "orchestrator",
          taskId: "bd-456",
          cwd: "/tmp/ws/builder-auth",
        })
      );
    });

    it("builder creates helper with own workspace as default cwd", async () => {
      vi.mocked(getAgent).mockReturnValue({
        type: "builder",
        parent: "orchestrator",
        sessionId: null,
        status: "active",
        workspace: "/tmp/ws/builder-auth",
        epicId: null,
        createdAt: new Date().toISOString(),
        children: [],
      });

      createAgentTools(builderCtx());
      const result = await callTool("agent_create", {
        type: "helper",
        name: "helper-tests",
        task_id: "bd-789",
      });

      expect(result.isError).toBeUndefined();
      expect(createHelper).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/tmp/ws/builder-auth",
          parent: "builder-auth",
        })
      );
    });
  });

  describe("agent_list", () => {
    it("returns formatted agent list", async () => {
      vi.mocked(listAgents).mockReturnValue([
        {
          name: "builder-auth",
          entry: {
            type: "builder",
            parent: "orchestrator",
            sessionId: "sess-1",
            status: "active",
            workspace: "/tmp/ws/builder-auth",
            epicId: "bd-100",
            createdAt: new Date().toISOString(),
            children: ["helper-lint"],
          },
        },
      ]);
      vi.mocked(isAgentRunning).mockReturnValue(true);

      createAgentTools(orchestratorCtx());
      const result = await callTool("agent_list", {});

      expect(result.content[0].text).toContain("builder-auth");
      expect(result.content[0].text).toContain("loop=running");
      expect(result.content[0].text).toContain("bd-100");
    });

    it("builder only sees own children", async () => {
      createAgentTools(builderCtx());
      await callTool("agent_list", {});

      expect(listAgents).toHaveBeenCalledWith(
        expect.objectContaining({ parent: "builder-auth" })
      );
    });

    it("empty list returns message", async () => {
      vi.mocked(listAgents).mockReturnValue([]);
      createAgentTools(orchestratorCtx());
      const result = await callTool("agent_list", {});

      expect(result.content[0].text).toContain("No agents found");
    });
  });

  describe("agent_status", () => {
    it("returns detailed agent info as JSON", async () => {
      vi.mocked(getAgent).mockReturnValue({
        type: "builder",
        parent: "orchestrator",
        sessionId: "sess-abc",
        status: "active",
        workspace: "/tmp/ws/builder-auth",
        epicId: "bd-100",
        createdAt: "2026-04-22T00:00:00Z",
        children: [],
      });
      vi.mocked(isAgentRunning).mockReturnValue(true);

      createAgentTools(orchestratorCtx());
      const result = await callTool("agent_status", { name: "builder-auth" });

      const info = JSON.parse(result.content[0].text);
      expect(info.name).toBe("builder-auth");
      expect(info.type).toBe("builder");
      expect(info.running).toBe(true);
      expect(info.epicId).toBe("bd-100");
    });

    it("builder cannot inspect non-child", async () => {
      vi.mocked(getAgent).mockReturnValue({
        type: "helper",
        parent: "builder-other",
        sessionId: null,
        status: "active",
        taskId: null,
        cwd: "/tmp",
        createdAt: new Date().toISOString(),
      });

      createAgentTools(builderCtx());
      const result = await callTool("agent_status", { name: "helper-foreign" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not a child");
    });

    it("returns error for unknown agent", async () => {
      vi.mocked(getAgent).mockReturnValue(undefined);
      createAgentTools(orchestratorCtx());
      const result = await callTool("agent_status", { name: "ghost" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });
  });

  describe("agent_destroy", () => {
    it("orchestrator can destroy an agent", async () => {
      vi.mocked(getAgent).mockReturnValue({
        type: "helper",
        parent: "builder-auth",
        sessionId: null,
        status: "active",
        taskId: null,
        cwd: "/tmp",
        createdAt: new Date().toISOString(),
      });

      createAgentTools(orchestratorCtx());
      const result = await callTool("agent_destroy", { name: "helper-cleanup" });

      expect(result.isError).toBeUndefined();
      expect(destroyAgentByName).toHaveBeenCalledWith("helper-cleanup");
    });

    it("cannot destroy the orchestrator", async () => {
      vi.mocked(getAgent).mockReturnValue({
        type: "orchestrator",
        sessionId: null,
        status: "active",
        createdAt: new Date().toISOString(),
        children: [],
      });

      createAgentTools(orchestratorCtx());
      const result = await callTool("agent_destroy", { name: "orchestrator" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Cannot destroy the Orchestrator");
    });

    it("builder can only destroy own children", async () => {
      vi.mocked(getAgent).mockReturnValue({
        type: "helper",
        parent: "builder-other",
        sessionId: null,
        status: "active",
        taskId: null,
        cwd: "/tmp",
        createdAt: new Date().toISOString(),
      });

      createAgentTools(builderCtx());
      const result = await callTool("agent_destroy", { name: "helper-foreign" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("only destroy its own children");
    });
  });

  describe("worktree_add", () => {
    it("adds a worktree to a workspace", async () => {
      vi.mocked(getAgent).mockReturnValue(undefined);

      createAgentTools(orchestratorCtx());
      const result = await callTool("worktree_add", {
        workspace: "/tmp/ws/builder-test",
        repo: "/tmp/my-repo",
        builder_name: "builder-test",
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Worktree added");
      expect(addWorktreeToWorkspace).toHaveBeenCalled();
    });

    it("builder cannot modify another builder's workspace", async () => {
      vi.mocked(getAgent).mockReturnValue({
        type: "builder",
        parent: "orchestrator",
        sessionId: null,
        status: "active",
        workspace: "/tmp/ws/builder-auth",
        epicId: null,
        createdAt: new Date().toISOString(),
        children: [],
      });

      createAgentTools(builderCtx());
      const result = await callTool("worktree_add", {
        workspace: "/tmp/ws/builder-OTHER",
        repo: "/tmp/repo",
        builder_name: "builder-OTHER",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("only modify their own workspace");
    });
  });

  describe("worktree_remove", () => {
    it("removes a worktree", async () => {
      vi.mocked(getAgent).mockReturnValue(undefined);

      createAgentTools(orchestratorCtx());
      const result = await callTool("worktree_remove", {
        workspace: "/tmp/ws/builder-test",
        worktree_name: "my-repo",
      });

      expect(result.isError).toBeUndefined();
      expect(removeWorktreeFromWorkspace).toHaveBeenCalledWith(
        "/tmp/ws/builder-test",
        "my-repo"
      );
    });
  });
});
