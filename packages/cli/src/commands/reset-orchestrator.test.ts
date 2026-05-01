import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testHome = join(tmpdir(), `friday-reset-orch-${process.pid}-${Date.now()}`);
const fridayDir = join(testHome, ".friday");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

const mockIsRunning = vi.fn().mockReturnValue(false);

vi.mock("../services.js", async () => {
  const actual = await vi.importActual<any>("../services.js");
  return { ...actual, isRunning: (...args: any[]) => mockIsRunning(...args) };
});

const { resetOrchestratorCommand } = await import("./reset-orchestrator.js");
const { writeState } = await import("../state.js");

function setupAgentsAndChannels(orchestratorChannelId: string): void {
  mkdirSync(fridayDir, { recursive: true });
  mkdirSync(join(fridayDir, "sessions"), { recursive: true });
  writeFileSync(
    join(fridayDir, "agents.json"),
    JSON.stringify({ orchestrator: { sessionId: "abc-123" } }, null, 2)
  );
  writeFileSync(
    join(fridayDir, "sessions", "channels.json"),
    JSON.stringify({ [orchestratorChannelId]: "channel-session-xyz" })
  );
  writeFileSync(
    join(fridayDir, "config.json"),
    JSON.stringify({ slack: { orchestratorChannelId } })
  );
}

describe("resetOrchestratorCommand", () => {
  beforeEach(() => {
    mockIsRunning.mockReturnValue(false);
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it("clears orchestrator session and channel mapping when daemon is stopped", () => {
    setupAgentsAndChannels("C123");

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    resetOrchestratorCommand();

    const agents = JSON.parse(readFileSync(join(fridayDir, "agents.json"), "utf-8"));
    expect(agents.orchestrator.sessionId).toBeNull();

    const channels = JSON.parse(readFileSync(join(fridayDir, "sessions", "channels.json"), "utf-8"));
    expect(channels["C123"]).toBeUndefined();

    expect(logs.join("\n")).toContain("Orchestrator session reset");

    mock.mockRestore();
  });

  it("refuses to run while daemon is alive", () => {
    setupAgentsAndChannels("C123");
    writeState("daemon", {
      pid: 12345, mode: "prod",
      startedAt: "2026-05-01T00:00:00Z",
      command: ["friday", "start", "daemon"],
      logPath: "/x",
    });
    mockIsRunning.mockReturnValue(true);

    const errs: string[] = [];
    const errMock = vi.spyOn(console, "error").mockImplementation((m) => errs.push(String(m)));
    const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    expect(() => resetOrchestratorCommand()).toThrow("process.exit");
    expect(errs.join("\n")).toContain("Daemon is still running");

    errMock.mockRestore();
    exitMock.mockRestore();
  });

  it("reports 'nothing to reset' when no orchestrator state exists", () => {
    mkdirSync(fridayDir, { recursive: true });

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    resetOrchestratorCommand();
    expect(logs.join("\n")).toContain("No orchestrator session to reset");

    mock.mockRestore();
  });
});
