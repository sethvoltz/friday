import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testHome = join(tmpdir(), `friday-status-test-${process.pid}-${Date.now()}`);
const fridayDir = join(testHome, ".friday");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

const mockIsRunning = vi.fn();
const mockHasSession = vi.fn();
const mockIsPaneDead = vi.fn();

vi.mock("../services.js", async () => {
  const actual = await vi.importActual<any>("../services.js");
  return {
    ...actual,
    isRunning: (...args: any[]) => mockIsRunning(...args),
  };
});

vi.mock("../tmux.js", () => ({
  hasSession: (...args: any[]) => mockHasSession(...args),
  isPaneDead: (...args: any[]) => mockIsPaneDead(...args),
}));

const { statusCommand } = await import("./status.js");
const { writeState } = await import("../state.js");

describe("statusCommand (human output)", () => {
  beforeEach(() => {
    mkdirSync(fridayDir, { recursive: true });
    mockIsRunning.mockReturnValue(false);
    mockHasSession.mockReturnValue(false);
    mockIsPaneDead.mockReturnValue(false);
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it("reports services as stopped when no state files exist", () => {
    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    statusCommand();
    const out = logs.join("\n");
    expect(out).toContain("Friday Status");
    expect(out).toContain("Friday daemon: not running");
    expect(out).toContain("Dashboard: not running");

    mock.mockRestore();
  });

  it("reports running prod service with mode label", () => {
    writeState("daemon", {
      pid: 12345, mode: "prod",
      startedAt: new Date().toISOString(),
      command: ["friday", "start", "daemon"],
      logPath: join(fridayDir, "logs", "daemon.jsonl"),
    });
    mockIsRunning.mockReturnValue(true);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    statusCommand();
    const out = logs.join("\n");
    expect(out).toContain("running (prod, PID 12345)");

    mock.mockRestore();
  });

  it("reports running dev service with tmux session", () => {
    writeState("dashboard", {
      pid: 7001, panePid: 7000, mode: "dev",
      tmuxSession: "friday-dashboard",
      startedAt: new Date().toISOString(),
      command: ["friday", "start", "dashboard", "--dev"],
      logPath: join(fridayDir, "logs", "dashboard.jsonl"),
    });
    mockIsRunning.mockReturnValue(true);
    mockHasSession.mockReturnValue(true);
    mockIsPaneDead.mockReturnValue(false);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    statusCommand();
    const out = logs.join("\n");
    expect(out).toContain("running (dev, PID 7001, tmux friday-dashboard)");

    mock.mockRestore();
  });

  it("crashed message suggests both attach (inspect) and restart (relaunch)", () => {
    writeState("dashboard", {
      pid: 7001, mode: "dev", tmuxSession: "friday-dashboard",
      startedAt: "2026-05-01T15:00:00Z",
      command: ["friday", "start", "dashboard", "--dev"],
      logPath: join(fridayDir, "logs", "dashboard.jsonl"),
    });
    mockIsRunning.mockReturnValue(false);
    mockHasSession.mockReturnValue(true);
    mockIsPaneDead.mockReturnValue(true);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    statusCommand(["dashboard"]);
    const out = logs.join("\n");
    expect(out).toContain("crashed");
    expect(out).toContain("friday attach dashboard");
    expect(out).toContain("friday restart dashboard");

    mock.mockRestore();
  });

  it("stale message suggests `friday start [--dev]` for recovery", () => {
    writeState("dashboard", {
      pid: 99999, mode: "dev", tmuxSession: "friday-dashboard",
      startedAt: "2026-05-01T15:00:00Z",
      command: ["friday", "start", "dashboard", "--dev"],
      logPath: join(fridayDir, "logs", "dashboard.jsonl"),
    });
    mockIsRunning.mockReturnValue(false);
    mockHasSession.mockReturnValue(false);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    statusCommand(["dashboard"]);
    const out = logs.join("\n");
    expect(out).toContain("stale");
    expect(out).toContain("friday start dashboard --dev");

    mock.mockRestore();
  });

  it("reports crashed when tmux session exists but pane is dead", () => {
    writeState("dashboard", {
      pid: 7001, panePid: 7000, mode: "dev",
      tmuxSession: "friday-dashboard",
      startedAt: new Date().toISOString(),
      command: ["friday", "start", "dashboard", "--dev"],
      logPath: join(fridayDir, "logs", "dashboard.jsonl"),
    });
    mockIsRunning.mockReturnValue(false);
    mockHasSession.mockReturnValue(true);
    mockIsPaneDead.mockReturnValue(true);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    statusCommand();
    expect(logs.join("\n")).toContain("crashed");

    mock.mockRestore();
  });

  it("reports stale when state file exists but neither pid nor session", () => {
    writeState("dashboard", {
      pid: 99999, mode: "dev",
      tmuxSession: "friday-dashboard",
      startedAt: new Date().toISOString(),
      command: ["friday", "start", "dashboard", "--dev"],
      logPath: join(fridayDir, "logs", "dashboard.jsonl"),
    });
    mockIsRunning.mockReturnValue(false);
    mockHasSession.mockReturnValue(false);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    statusCommand();
    expect(logs.join("\n")).toContain("stale");

    mock.mockRestore();
  });
});

describe("statusCommand (--json)", () => {
  beforeEach(() => {
    mkdirSync(fridayDir, { recursive: true });
    mockIsRunning.mockReturnValue(false);
    mockHasSession.mockReturnValue(false);
    mockIsPaneDead.mockReturnValue(false);
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it("emits the contract shape for a single running service", () => {
    writeState("daemon", {
      pid: 100, mode: "prod",
      startedAt: "2026-05-01T15:00:00.000Z",
      command: ["friday", "start", "daemon"],
      logPath: join(fridayDir, "logs", "daemon.jsonl"),
    });
    mockIsRunning.mockReturnValue(true);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    statusCommand(["daemon", "--json"]);
    const obj = JSON.parse(logs.join("\n"));
    expect(obj.service).toBe("daemon");
    expect(obj.state).toBe("running");
    expect(obj.mode).toBe("prod");
    expect(obj.pid).toBe(100);
    expect(obj.startedAt).toBe("2026-05-01T15:00:00.000Z");
    expect(obj.startCommand).toEqual(["friday", "start", "daemon"]);

    mock.mockRestore();
  });

  it("emits an array when no service is specified", () => {
    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    statusCommand(["--json"]);
    const obj = JSON.parse(logs.join("\n"));
    expect(Array.isArray(obj)).toBe(true);
    expect(obj.map((x: { service: string }) => x.service)).toEqual(["daemon", "dashboard"]);
    for (const entry of obj) expect(entry.state).toBe("stopped");

    mock.mockRestore();
  });
});

describe("statusCommandCitty (parity via citty runCommand)", () => {
  beforeEach(() => {
    mkdirSync(fridayDir, { recursive: true });
    mockIsRunning.mockReturnValue(false);
    mockHasSession.mockReturnValue(false);
    mockIsPaneDead.mockReturnValue(false);
  });
  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it("--json yields the same shape as the legacy entrypoint", async () => {
    writeState("daemon", {
      pid: 100, mode: "prod",
      startedAt: "2026-05-01T15:00:00.000Z",
      command: ["friday", "start", "daemon"],
      logPath: join(fridayDir, "logs", "daemon.jsonl"),
    });
    mockIsRunning.mockReturnValue(true);

    const { runCommand } = await import("citty");
    const { statusCommandCitty } = await import("./status.js");

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
    await runCommand(statusCommandCitty, { rawArgs: ["daemon", "--json"] });
    const obj = JSON.parse(logs.join("\n"));
    expect(obj.service).toBe("daemon");
    expect(obj.state).toBe("running");
    expect(obj.pid).toBe(100);
    mock.mockRestore();
  });
});
