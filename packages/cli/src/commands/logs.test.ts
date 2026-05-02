import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
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

  it("--pretty reformats lines (level, event, ts visible; not raw JSON)", async () => {
    writeJsonlLines([{ ts: "T1", level: "error", event: "boom", err: "x" }]);

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    await logsCommand(["daemon", "--pretty"]);

    expect(logs[0]).toContain("error");
    expect(logs[0]).toContain("boom");
    expect(logs[0]).toContain("T1");
    // Pretty output is not raw JSON — should not contain the surrounding {"ts":...
    expect(logs[0]).not.toMatch(/^\{"ts":/);

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

  it("spans rotated .jsonl.gz siblings when -n exceeds active file's lines", async () => {
    const logsDir = join(fridayDir, "logs");
    mkdirSync(logsDir, { recursive: true });

    // Two rotated files (older and newer) plus the active file.
    const older = ["o1", "o2"].map((ev) => ({ ts: "T0", level: "info", event: ev }));
    const newer = ["n1", "n2"].map((ev) => ({ ts: "T1", level: "info", event: ev }));
    const active = [{ ts: "T2", level: "info", event: "active1" }];

    const olderText = older.map((l) => JSON.stringify(l)).join("\n") + "\n";
    const newerText = newer.map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeFileSync(
      join(logsDir, "daemon-2026-05-01T10-00-00-000Z.jsonl.gz"),
      gzipSync(Buffer.from(olderText))
    );
    writeFileSync(
      join(logsDir, "daemon-2026-05-01T11-00-00-000Z.jsonl.gz"),
      gzipSync(Buffer.from(newerText))
    );
    writeFileSync(
      join(logsDir, "daemon.jsonl"),
      active.map((l) => JSON.stringify(l)).join("\n") + "\n"
    );

    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));

    await logsCommand(["daemon", "-n", "4"]);

    // Expect the 4 most recent lines, in order: n1, n2, active1 — only 3 from
    // the newer rotation + active. Walk back into older to fill: o2, n1, n2, active1.
    expect(logs.length).toBe(4);
    expect(logs[0]).toContain('"event":"o2"');
    expect(logs[1]).toContain('"event":"n1"');
    expect(logs[2]).toContain('"event":"n2"');
    expect(logs[3]).toContain('"event":"active1"');

    mock.mockRestore();
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
