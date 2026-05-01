import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "./log.js";

const dir = join(tmpdir(), `friday-log-test-${process.pid}-${Date.now()}`);
const logPath = join(dir, "svc.jsonl");

function listEntries(): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

describe("createLogger", () => {
  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lazily opens the FD — no file appears just by creating the logger", () => {
    createLogger({ service: "svc", logPath, stdoutMode: "off" });
    expect(existsSync(logPath)).toBe(false);
  });

  it("writes JSONL lines to the configured path", () => {
    const logger = createLogger({ service: "svc", logPath, stdoutMode: "off" });
    logger.log("info", "hello", { who: "world" });
    logger.log("debug", "noise", {});
    logger.close();

    const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.event).toBe("hello");
    expect(first.level).toBe("info");
    expect(first.who).toBe("world");
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rotates and gzips when the file passes rotateBytes", () => {
    // 1 KiB threshold, lines that easily push past it after a few writes
    const logger = createLogger({
      service: "svc",
      logPath,
      stdoutMode: "off",
      rotateBytes: 1024,
    });
    const filler = "x".repeat(200);
    for (let i = 0; i < 20; i++) {
      logger.log("info", "burst", { i, filler });
    }
    logger.close();

    const entries = listEntries();
    // We expect at least one rotated .jsonl.gz file plus the active .jsonl
    const rotated = entries.filter((e) => e.endsWith(".jsonl.gz"));
    expect(rotated.length).toBeGreaterThanOrEqual(1);
    expect(entries).toContain("svc.jsonl");

    // Rotated file is well-formed gzip and contains valid JSONL
    const decoded = gunzipSync(readFileSync(join(dir, rotated[0]))).toString("utf-8");
    const decodedLines = decoded.split("\n").filter(Boolean);
    expect(decodedLines.length).toBeGreaterThan(0);
    for (const line of decodedLines) {
      const parsed = JSON.parse(line);
      expect(parsed.event).toBe("burst");
    }

    // No content lost: rotated lines + active lines = 20 total
    const activeLines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    let totalRotated = 0;
    for (const f of rotated) {
      const text = gunzipSync(readFileSync(join(dir, f))).toString("utf-8");
      totalRotated += text.split("\n").filter(Boolean).length;
    }
    expect(totalRotated + activeLines.length).toBe(20);
  });

  it("rotated filenames are sortable by ISO timestamp", () => {
    const logger = createLogger({ service: "svc", logPath, stdoutMode: "off", rotateBytes: 256 });
    for (let i = 0; i < 30; i++) {
      logger.log("info", "x", { pad: "y".repeat(50) });
    }
    logger.close();

    const rotated = listEntries().filter((e) => e.endsWith(".jsonl.gz"));
    expect(rotated.length).toBeGreaterThanOrEqual(2);
    const sorted = [...rotated].sort();
    expect(rotated).toEqual(sorted);
  });

  it("starting against a pre-existing oversized file rotates on first write", () => {
    // Simulate a service whose log file was already past threshold at boot.
    writeFileSync(logPath, "x".repeat(2048));
    const logger = createLogger({
      service: "svc",
      logPath,
      stdoutMode: "off",
      rotateBytes: 1024,
    });
    logger.log("info", "hello", {});
    logger.close();

    const entries = listEntries();
    const rotated = entries.filter((e) => e.endsWith(".jsonl.gz"));
    expect(rotated.length).toBe(1);
    // Active file now contains only the post-rotation write
    const active = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    expect(active.length).toBe(1);
    expect(JSON.parse(active[0]).event).toBe("hello");
  });

  it("close() makes subsequent log() calls throw", () => {
    const logger = createLogger({ service: "svc", logPath, stdoutMode: "off" });
    logger.log("info", "a", {});
    logger.close();
    expect(() => logger.log("info", "b", {})).toThrow(/already closed/);
  });

  it("does not produce a file if the logger is created and closed without writing", () => {
    const logger = createLogger({ service: "svc", logPath, stdoutMode: "off" });
    logger.close();
    expect(existsSync(logPath)).toBe(false);
  });

  it("close() flushes the current size but does not rotate", () => {
    const logger = createLogger({ service: "svc", logPath, stdoutMode: "off", rotateBytes: 1024 });
    logger.log("info", "small", {});
    logger.close();
    // File should exist and not be rotated since we wrote well under threshold
    expect(statSync(logPath).size).toBeGreaterThan(0);
    expect(listEntries().filter((e) => e.endsWith(".gz"))).toEqual([]);
  });
});
