import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `friday-registry-${process.pid}-${Date.now()}`);
const fridayDir = join(testDir, ".friday");
const agentsPath = join(fridayDir, "agents.json");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testDir };
});

vi.mock("../log.js", () => ({ log: vi.fn() }));

const {
  loadRegistry,
  getAgent,
  listAgents,
  registerOrchestrator,
  registerBuilder,
  registerHelper,
  updateAgentSession,
  updateAgentStatus,
  destroyAgent,
  _resetForTesting,
} = await import("./registry.js");

describe("agent registry", () => {
  beforeEach(() => {
    mkdirSync(fridayDir, { recursive: true });
    _resetForTesting();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("loads empty registry when no file exists", () => {
    loadRegistry();
    expect(listAgents()).toEqual([]);
  });

  it("registers orchestrator", () => {
    const orch = registerOrchestrator();
    expect(orch.type).toBe("orchestrator");
    expect(orch.status).toBe("active");
    expect(orch.children).toEqual([]);

    // Persisted
    const saved = JSON.parse(readFileSync(agentsPath, "utf-8"));
    expect(saved.orchestrator).toBeDefined();
  });

  it("returns existing orchestrator on repeat registration", () => {
    const first = registerOrchestrator();
    const second = registerOrchestrator();
    expect(first.createdAt).toBe(second.createdAt);
  });

  it("registers builder under orchestrator", () => {
    registerOrchestrator();
    const builder = registerBuilder(
      "builder-auth",
      "orchestrator",
      "/tmp/workspace/builder-auth",
      "bd-a1b2"
    );

    expect(builder.type).toBe("builder");
    expect(builder.parent).toBe("orchestrator");
    expect(builder.workspace).toBe("/tmp/workspace/builder-auth");
    expect(builder.epicId).toBe("bd-a1b2");

    const orch = getAgent("orchestrator")!;
    expect("children" in orch && orch.children).toContain("builder-auth");
  });

  it("rejects builder with invalid name", () => {
    registerOrchestrator();
    expect(() =>
      registerBuilder("a", "orchestrator", "/tmp", null)
    ).toThrow("Invalid agent name");
  });

  it("rejects duplicate agent name", () => {
    registerOrchestrator();
    registerBuilder("builder-auth", "orchestrator", "/tmp", null);
    expect(() =>
      registerBuilder("builder-auth", "orchestrator", "/tmp", null)
    ).toThrow("already taken");
  });

  it("rejects re-registering a destroyed builder name", () => {
    registerOrchestrator();
    registerBuilder("builder-auth", "orchestrator", "/tmp/old", "epic-1");
    destroyAgent("builder-auth");
    expect(getAgent("builder-auth")!.status).toBe("destroyed");

    expect(() =>
      registerBuilder("builder-auth", "orchestrator", "/tmp/new", "epic-2")
    ).toThrow("already taken");
  });

  it("rejects re-registering a destroyed helper name", () => {
    registerOrchestrator();
    registerBuilder("builder-x", "orchestrator", "/tmp", null);
    registerHelper("helper-task", "builder-x", "task-1", "/tmp/cwd");
    destroyAgent("helper-task");
    expect(getAgent("helper-task")!.status).toBe("destroyed");

    expect(() =>
      registerHelper("helper-task", "builder-x", "task-2", "/tmp/cwd2")
    ).toThrow("already taken");
  });

  it("rejects builder created by non-orchestrator", () => {
    registerOrchestrator();
    registerBuilder("builder-auth", "orchestrator", "/tmp", null);
    expect(() =>
      registerBuilder("builder-other", "builder-auth", "/tmp", null)
    ).toThrow("Only the Orchestrator");
  });

  it("registers helper under orchestrator or builder", () => {
    registerOrchestrator();
    registerBuilder("builder-auth", "orchestrator", "/tmp", null);

    const helperUnderOrch = registerHelper(
      "helper-orchestrator-cleanup",
      "orchestrator",
      "bd-c3d4",
      "/tmp"
    );
    expect(helperUnderOrch.type).toBe("helper");
    expect(helperUnderOrch.parent).toBe("orchestrator");

    const helperUnderBuilder = registerHelper(
      "helper-auth-tests",
      "builder-auth",
      "bd-e5f6",
      "/tmp/workspace/builder-auth"
    );
    expect(helperUnderBuilder.parent).toBe("builder-auth");

    const builder = getAgent("builder-auth")!;
    expect("children" in builder && builder.children).toContain("helper-auth-tests");
  });

  it("rejects helper created by another helper", () => {
    registerOrchestrator();
    registerHelper("helper-orchestrator-first", "orchestrator", null, "/tmp");
    expect(() =>
      registerHelper("helper-nested", "helper-orchestrator-first", null, "/tmp")
    ).toThrow("Helpers cannot create");
  });

  it("updates agent session ID", () => {
    registerOrchestrator();
    updateAgentSession("orchestrator", "sess-abc");
    expect(getAgent("orchestrator")!.sessionId).toBe("sess-abc");
  });

  it("updates agent status", () => {
    registerOrchestrator();
    updateAgentStatus("orchestrator", "idle");
    expect(getAgent("orchestrator")!.status).toBe("idle");
  });

  it("destroys agent and removes from parent", () => {
    registerOrchestrator();
    registerBuilder("builder-auth", "orchestrator", "/tmp", null);

    destroyAgent("builder-auth");

    expect(getAgent("builder-auth")!.status).toBe("destroyed");
    const orch = getAgent("orchestrator")!;
    expect("children" in orch && orch.children).not.toContain("builder-auth");
  });

  it("recursively destroys children when destroying builder", () => {
    registerOrchestrator();
    registerBuilder("builder-auth", "orchestrator", "/tmp", null);
    registerHelper("helper-auth-tests", "builder-auth", null, "/tmp");

    destroyAgent("builder-auth");

    expect(getAgent("builder-auth")!.status).toBe("destroyed");
    expect(getAgent("helper-auth-tests")!.status).toBe("destroyed");
  });

  it("cannot destroy orchestrator", () => {
    registerOrchestrator();
    expect(() => destroyAgent("orchestrator")).toThrow("Cannot destroy");
  });

  it("lists agents with filters", () => {
    registerOrchestrator();
    registerBuilder("builder-auth", "orchestrator", "/tmp", null);
    registerHelper("helper-auth-tests", "builder-auth", null, "/tmp");

    const all = listAgents();
    expect(all).toHaveLength(3);

    const builders = listAgents({ type: "builder" });
    expect(builders).toHaveLength(1);
    expect(builders[0].name).toBe("builder-auth");

    const orchestratorChildren = listAgents({ parent: "orchestrator" });
    expect(orchestratorChildren).toHaveLength(1);
    expect(orchestratorChildren[0].name).toBe("builder-auth");

    const active = listAgents({ status: "active" });
    expect(active).toHaveLength(3);
  });

  it("persists and reloads across loadRegistry calls", () => {
    registerOrchestrator();
    registerBuilder("builder-auth", "orchestrator", "/tmp", null);

    _resetForTesting();
    expect(listAgents()).toHaveLength(0);

    loadRegistry();
    expect(listAgents()).toHaveLength(2);
    expect(getAgent("builder-auth")!.type).toBe("builder");
  });
});
