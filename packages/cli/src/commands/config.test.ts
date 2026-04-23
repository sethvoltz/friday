import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `friday-config-test-${process.pid}-${Date.now()}`);
const fridayDir = join(testDir, ".friday");
const configPath = join(fridayDir, "config.json");

// Mock only the homedir so @friday/shared derives paths from our temp dir.
// The real loadConfig is used — no reimplementation.
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testDir };
});

const { configCommand } = await import("./config.js");
const { CONFIG_PATH } = await import("@friday/shared");

describe("configCommand", () => {
  beforeEach(() => {
    mkdirSync(fridayDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("--path prints config path", () => {
    const logs: string[] = [];
    const mockLog = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    configCommand(["--path"]);
    expect(logs[0]).toBe(CONFIG_PATH);

    mockLog.mockRestore();
  });

  it("prints defaults when no config file", () => {
    const logs: string[] = [];
    const mockLog = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    configCommand([]);
    const output = logs.join("\n");
    expect(output).toContain("No config file found");
    expect(output).toContain("claude-sonnet-4-6");
    // Verify it's valid JSON after the header lines
    const jsonLine = logs.find((l) => l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    expect(() => JSON.parse(jsonLine!)).not.toThrow();

    mockLog.mockRestore();
  });

  it("prints config from file with deep-merged defaults", () => {
    writeFileSync(configPath, JSON.stringify({
      slack: { orchestratorChannelId: "C999" },
    }));

    const logs: string[] = [];
    const mockLog = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    configCommand([]);
    const output = logs.join("\n");
    // User override present
    expect(output).toContain("C999");
    // Defaults present via real deep merge
    expect(output).toContain("claude-sonnet-4-6");
    expect(output).toContain("eyes");

    mockLog.mockRestore();
  });

  it("--validate passes for valid config", () => {
    writeFileSync(configPath, JSON.stringify({
      slack: { orchestratorChannelId: "C123" },
      agent: { workingDirectory: testDir, model: "claude-sonnet-4-6" },
    }));

    const logs: string[] = [];
    const mockLog = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    configCommand(["--validate"]);
    const output = logs.join("\n");
    expect(output).toContain("Config is valid");

    mockLog.mockRestore();
  });

  it("--validate reports missing orchestratorChannelId", () => {
    // No config file → defaults have empty channel ID
    const logs: string[] = [];
    const mockLog = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    expect(() => configCommand(["--validate"])).toThrow("process.exit");
    const output = logs.join("\n");
    expect(output).toContain("orchestratorChannelId");

    mockLog.mockRestore();
    mockExit.mockRestore();
  });

  it("--validate warns when workingDirectory does not exist", () => {
    writeFileSync(configPath, JSON.stringify({
      slack: { orchestratorChannelId: "C123" },
      agent: { workingDirectory: "/nonexistent/path/abc", model: "claude-sonnet-4-6" },
    }));

    const logs: string[] = [];
    const mockLog = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    // Warnings alone should NOT cause exit
    configCommand(["--validate"]);
    const output = logs.join("\n");
    expect(output).toContain("workingDirectory");
    expect(output).toContain("Warnings");

    mockLog.mockRestore();
  });
});
