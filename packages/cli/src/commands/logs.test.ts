import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testHome = join(tmpdir(), `friday-logs-test-${process.pid}-${Date.now()}`);
const fridayDir = join(testHome, ".friday");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

const { logsCommand } = await import("./logs.js");

function writeJsonlLines(lines: object[]): string {
  const path = join(fridayDir, "logs", "daemon.jsonl");
  mkdirSync(join(fridayDir, "logs"), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

describe("logsCommand", () => {
  beforeEach(() => {
    mkdirSync(fridayDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it("prints last N lines as raw JSON by default", async () => {
    writeJsonlLines([
      { ts: "T1", level: "info", event: "a" },
      { ts: "T2", level: "info", event: "b" },
      { ts: "T3", level: "info", event: "c" },
    ]);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    await logsCommand(["daemon", "-n", "2"]);

    expect(logs.length).toBe(2);
    expect(logs[0]).toContain('"event":"b"');
    expect(logs[1]).toContain('"event":"c"');

    mock.mockRestore();
  });

  it("--pretty colorizes output", async () => {
    writeJsonlLines([{ ts: "T1", level: "error", event: "boom", err: "x" }]);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    await logsCommand(["daemon", "--pretty"]);

    expect(logs[0]).toContain("\x1b[31m"); // red for error level
    expect(logs[0]).toContain("error");
    expect(logs[0]).toContain("boom");

    mock.mockRestore();
  });

  it("errors when log file missing (no --follow)", async () => {
    const errs: string[] = [];
    const errMock = vi.spyOn(console, "error").mockImplementation((m) => errs.push(String(m)));
    const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    await expect(logsCommand(["daemon"])).rejects.toThrow("process.exit");
    expect(errs.join("\n")).toContain("No log file");

    errMock.mockRestore();
    exitMock.mockRestore();
  });

  it("rejects 'all' as a target", async () => {
    const errs: string[] = [];
    const errMock = vi.spyOn(console, "error").mockImplementation((m) => errs.push(String(m)));
    const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    await expect(logsCommand([])).rejects.toThrow("process.exit");
    expect(errs.join("\n")).toContain("Specify a single service");

    errMock.mockRestore();
    exitMock.mockRestore();
  });
});
